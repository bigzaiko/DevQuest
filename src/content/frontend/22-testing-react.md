---
id: fe-22
title: Testing React with Vitest & Testing Library
level: advanced
minutes: 65
xp: 200
summary: Set up Vitest + React Testing Library, query like a user (getByRole first), drive the UI with user-event, mock the network, test hooks — and learn what not to test. Then write tests that catch real bugs.
---

Tests are not about proving your code works today. They're about letting you — and the colleague who joins
next year — **change it tomorrow without fear**. A good test suite makes refactoring boring. A bad one breaks on
every refactor while letting real bugs through. This lesson is about writing the good kind.

## The guiding principle

Testing Library's motto sums up modern frontend testing:

> The more your tests resemble the way your software is used, the more confidence they can give you.
> — Kent C. Dodds

Users don't know about your component's state variables, its hooks, or its CSS classes. They see **text**,
**roles** (buttons, textboxes, headings) and **labels**, and they click and type. So tests should:

- find elements the way users (and assistive technology) do — by role, label and text,
- interact through real events (click, type, keyboard),
- assert on what's **visible** (text appears, button gets disabled, a callback is called with the right data).

That makes tests resistant to refactoring: rename a state variable, switch from `useState` to `useReducer`, split a
component — the test doesn't care, because the *behaviour* didn't change.

### What kind of tests?

| Kind | Tool | Scope | Speed |
|---|---|---|---|
| **Unit** | Vitest | a pure function, reducer, service, formatter | ~1 ms |
| **Component / integration** | Vitest + React Testing Library + jsdom | a component or a feature with its children, network mocked | ~10–100 ms |
| **End-to-end** | Playwright (next lesson) | the real app in a real browser against a real or stubbed backend | seconds |

Most of your confidence per minute comes from the middle row: component tests that render a feature, interact like a
user, and mock only the network boundary. Kent C. Dodds calls this shape the **testing trophy** (a twist on the
classic "test pyramid"): static checks (TypeScript, ESLint) at the base, plenty of unit tests for pure logic, the
**biggest** layer is integration/component tests, and a small cap of critical e2e flows.

Two terms you'll see below:

- **jsdom** — a JavaScript implementation of the browser DOM that runs inside Node. It has `document`, events and
  forms, but **no layout engine and no real rendering**: `getBoundingClientRect()` returns zeros, CSS media
  queries don't apply, and there is no real network. That's why it's fast — and why some things belong in e2e tests.
- **Test runner** — the program that finds `*.test.ts(x)` files, runs them and reports results. **Vitest** is the
  runner built on Vite, so it understands your Vite config, TypeScript and JSX with zero extra setup. Its API
  (`describe`, `test`, `expect`, `vi.fn()`) is deliberately Jest-compatible, so Jest knowledge transfers.

:::lab id=fe-22-lab1 xp=80
title: Set up Vitest + React Testing Library in a Vite project
Start from any Vite React-TS app (`npm create vite@latest testing-lab -- --template react-ts`).

**1. Install**

```bash
npm i -D vitest jsdom @testing-library/react @testing-library/dom \
  @testing-library/user-event @testing-library/jest-dom @vitest/coverage-v8
```

**2. Configure Vitest** — it reuses your Vite config (plugins, aliases), so there's no separate Babel/Jest setup:

```ts
// vite.config.ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',              // a fake DOM in Node
    globals: true,                     // describe/test/expect without imports
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx'],
    },
  },
})
```

**3. The setup file** — runs before every test file. It adds DOM matchers like `toBeInTheDocument()` and unmounts
whatever the previous test rendered, so tests can't leak DOM into each other:

```ts
// src/test/setup.ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())
```

(With `globals: true`, React Testing Library registers this cleanup automatically; writing it explicitly does no
harm and keeps working if someone later turns `globals` off.)

**4. Types** — `tsconfig.app.json` in the Vite template already has `"types": ["vite/client"]`. **Add** to that
array rather than replacing it: `"types": ["vite/client", "vitest/globals"]`. The jest-dom matcher types come from
the `import '@testing-library/jest-dom/vitest'` in the setup file, which is type-checked because the template's
`"include": ["src"]` covers `src/test/setup.ts`.

:::warn title="Common mistake"
Writing `"types": ["vitest/globals"]` on its own **replaces** the template's list, and suddenly
`import.meta.env` and `import logo from './logo.svg'` stop type-checking. `types` is an allow-list, not an addition.
:::

**5. Scripts** in `package.json`:

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "coverage": "vitest run --coverage"
  }
}
```

**6. First test**, colocated next to the component:

```tsx
// src/Counter.tsx
import { useState } from 'react'
export function Counter() {
  const [n, setN] = useState(0)
  return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>
}
```

```tsx
// src/Counter.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Counter } from './Counter'

test('counts clicks', async () => {
  const user = userEvent.setup()
  render(<Counter />)
  await user.click(screen.getByRole('button', { name: /clicked 0 times/i }))
  expect(screen.getByRole('button')).toHaveTextContent('Clicked 1 times')
})
```

Run `npm test` — Vitest starts in **watch mode** and re-runs affected tests on save. Press `h` for shortcuts.
You should see something like:

```text
 ✓ src/Counter.test.tsx (1 test) 45ms
   ✓ counts clicks

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

Then break the component on purpose (`n + 2`) and watch the test fail with a readable diff
(`Expected element to have text content: Clicked 1 times / Received: Clicked 2 times`). In CI you use
`npm run test:run` — `vitest run` runs once and exits with a non-zero code on failure, instead of watching.

:::tip
`npx vitest --ui` (after `npm i -D @vitest/ui`) opens a browser dashboard of your tests. For components that
need real browser APIs (canvas, layout, IntersectionObserver) look at **Vitest Browser Mode**, which runs the same
tests in a real Chromium via Playwright.
:::

- [ ] `npm test` runs and the Counter test passes
- [ ] Breaking the component makes the test fail with a clear message
- [ ] `npm run coverage` prints a coverage table and writes `coverage/index.html`
- [ ] `expect(...).toBeInTheDocument()` type-checks in the editor (jest-dom types are loaded)
:::

## Queries: how to find elements

Testing Library queries come in three flavours and many "by" types.

| Prefix | No match | 1 match | >1 match | Async? | Use for |
|---|---|---|---|---|---|
| `getBy…` | throws | element | throws | no | things that must be there **now** |
| `queryBy…` | `null` | element | throws | no | asserting something is **absent** |
| `findBy…` | rejects | element | rejects | **yes** (retries ~1 s) | things that **will appear** (after fetch, timers) |

(`getAllBy…`, `queryAllBy…`, `findAllBy…` return arrays.)

The **priority** for the "by" part, from the Testing Library docs:

1. **`getByRole`** — `getByRole('button', { name: 'Save' })`, `getByRole('heading', { name: /settings/i })`,
   `getByRole('textbox', { name: 'Email' })`, `getByRole('checkbox', { name: 'Remember me' })`. This is how
   screen readers navigate, so it **also tests accessibility**: if you can't find your button by role and name,
   neither can a blind user.
2. **`getByLabelText`** — form fields by their `<label>`. Great for inputs (including `type="password"`, which has no role).
3. `getByPlaceholderText` — only if there's no label (and there should be one).
4. **`getByText`** — non-interactive content: paragraphs, messages, list items.
5. `getByDisplayValue`, `getByAltText`, `getByTitle` — special cases.
6. **`getByTestId`** — last resort, when nothing user-visible identifies the element (a chart canvas, a scroll container).

```tsx
// ❌ brittle: tied to markup and CSS
container.querySelector('.btn-primary')!
screen.getByTestId('submit-button')

// ✅ resilient: tied to what the user sees
screen.getByRole('button', { name: 'Submit order' })
```

Two details about `getByRole` that trip people up:

- **Roles are often implicit.** You rarely write `role="…"`: `<button>` has role `button`, `<a href>` is `link`,
  `<input type="text">` is `textbox`, `<input type="checkbox">` is `checkbox`, `<h1>`–`<h6>` are `heading`,
  `<ul>`/`<li>` are `list`/`listitem`. A `<div onClick>` has **no** role — so the test can't find it, which is
  exactly the accessibility bug you want to catch.
- **`name` is the accessible name**, i.e. what a screen reader announces: the button's text, the `<label>` of an
  input, or an `aria-label`. A string must match the **whole** name exactly (`'Save'` does not match
  `'Save draft'`); use a RegExp like `/save/i` for partial, case-insensitive matches.

:::tip title="When a query can't find something"
Call `screen.debug()` to print the current DOM. Better still, a failing `getByRole` already prints every role and
accessible name it *could* find — read that list before reaching for `getByTestId`.
:::

:::quiz id=fe-22-q4 xp=10
Spot the bug. The form renders `<label htmlFor="pw">Password</label><input id="pw" type="password" />`, and this
line throws "Unable to find an accessible element with the role textbox":

```tsx
await user.type(screen.getByRole('textbox', { name: 'Password' }), 's3cret!!')
```

What is the right fix?
- [ ] Add `role="textbox"` to the password input
- [x] Use `screen.getByLabelText('Password')` — password inputs have no ARIA role, so role queries can't see them
- [ ] Use `screen.getByRole('password', { name: 'Password' })`
- [ ] Switch to `screen.getByTestId('password')` and add a `data-testid`
> The ARIA spec deliberately gives `<input type="password">` no role (so assistive tech doesn't treat it like a
> normal text field), which makes `getByLabelText` the right query — and it still checks that a label exists. There
> is no `password` role, and adding `role="textbox"` changes how screen readers announce the field just to satisfy a
> test. `getByTestId` "works" but stops verifying that the field is labelled.
:::

:::quiz id=fe-22-q1 xp=15
Which assertions are written the Testing Library way? (Select all that apply.)
- [x] `expect(screen.queryByRole('alert')).toBeNull()` to prove no error message is shown
- [ ] `expect(screen.getByRole('alert')).toBeNull()` to prove no error message is shown
- [x] `expect(await screen.findByText('Saved')).toBeInTheDocument()` after clicking Save, which calls an API
- [ ] `expect(container.querySelector('.error')).toBeTruthy()`
- [x] `screen.getByLabelText('Password')` to find a password input
> `getBy` throws when nothing matches, so `expect(getByRole('alert')).toBeNull()` never reaches the `expect` — it
> fails with "Unable to find role alert" even when the UI is correct. Use `queryBy` (returns `null`) for absence.
> `findBy` waits for UI that appears after the API call. Password inputs are found by label. CSS selectors such as
> `.error` couple the test to markup and class names; labels and roles couple it to what the user perceives.
:::

## Interacting: `user-event`

`@testing-library/user-event` simulates **full interactions**, not single events. `user.type(input, 'hi')` fires
focus, keydown, keypress, input, keyup for each character — exactly like a browser. `fireEvent.change` just pokes
one event and can miss bugs (e.g. a handler on `keydown`).

```tsx
const user = userEvent.setup()      // once per test, before render
await user.type(screen.getByLabelText('Email'), 'ada@example.com')
await user.click(screen.getByRole('button', { name: 'Sign in' }))
await user.keyboard('{Escape}')
await user.tab()
```

Always `await` — user-event is async, and forgetting `await` produces flaky tests and "not wrapped in act(...)" warnings.

### What `act` is (and why you rarely call it)

React batches state updates and runs effects *later*, not at the moment you call `setState`. `act(() => …)` tells
React: "run this, then flush **all** resulting renders and effects before returning", so your assertion sees the
final UI. Testing Library already wraps `render`, every `user.*` call and the polling of `findBy`/`waitFor` in
`act` for you. You only write `act` yourself when you trigger an update **outside** those helpers — calling a
function returned by `renderHook`, advancing fake timers, or resolving a promise you control.

The warning *"An update to X inside a test was not wrapped in act(...)"* almost always means: a state update
happened after your test stopped waiting (a missing `await`, or a fetch that resolved after the last assertion).
Fix it by awaiting the UI that the update produces (`await screen.findBy…`), not by sprinkling `act` everywhere.

:::quiz id=fe-22-q5 xp=10
What happens with this test?

```tsx
test('adds a todo', async () => {
  const user = userEvent.setup()
  render(<TodoApp />)
  user.type(screen.getByLabelText('New todo'), 'Buy milk{Enter}')
  expect(screen.getByText('Buy milk')).toBeInTheDocument()
})
```

- [ ] It passes — `user.type` is synchronous in `userEvent.setup()` mode
- [x] It fails (or flakes): `user.type` returns a promise, so the assertion runs before any key is typed
- [ ] It passes, but only because jsdom runs events synchronously
- [ ] TypeScript refuses to compile it because the promise is unused
> Every `user.*` method is async — it types character by character, yielding between events. Without `await`, the
> `expect` runs while the input is still empty, so `getByText('Buy milk')` throws (and the leftover typing may
> trigger "not wrapped in act" warnings). TypeScript allows a floating promise; the ESLint rule
> `@typescript-eslint/no-floating-promises` (or `eslint-plugin-testing-library`'s `await-async-events`) is what catches it.
:::

## Your turn: be the tester

In the challenges below **you write the tests**. They must pass against the correct implementation (shown, read-only)
and **fail against every hidden buggy version** (mutants). This is called **mutation testing**, and it's the honest
measure of a test suite: 100 % coverage means nothing if a bug can slip through without a test failing. (Coverage
only says a line *ran*; it says nothing about whether any assertion would notice it being wrong.) In real projects
tools like **Stryker** generate mutants automatically and report a "mutation score".

In these sandboxes `render`, `screen`, `user`, `fn` and `act` are globals (no imports, no `userEvent.setup()`).

:::challenge id=fe-22-c1 lang=ts mode=tests xp=50
title: Catch the pagination bugs
`paginate(items, page, pageSize)` powers every table in the app. Pages are **1-based**; out-of-range pages are
clamped; an empty list still has one (empty) page. Write tests that catch all four hidden bugs.

hint: Test a middle page and the exact contents of `items` — off-by-one slicing is the classic bug.
hint: Use a length that isn't a multiple of `pageSize` (e.g. 7 items, size 3) to test `totalPages`.
hint: Check `hasNext` on the **last** page, and ask for page 99.
hint: What should `paginate([], 1, 10).totalPages` be?

```ts impl
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(Math.max(1, page), totalPages)
  const start = (current - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    page: current,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
  }
}
```

```ts mutant
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(Math.max(1, page), totalPages)
  const start = current * pageSize
  return { items: items.slice(start, start + pageSize), page: current, totalPages, hasPrev: current > 1, hasNext: current < totalPages }
}
```

```ts mutant
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.floor(items.length / pageSize))
  const current = Math.min(Math.max(1, page), totalPages)
  const start = (current - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page: current, totalPages, hasPrev: current > 1, hasNext: current < totalPages }
}
```

```ts mutant
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(Math.max(1, page), totalPages)
  const start = (current - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page: current, totalPages, hasPrev: current > 1, hasNext: current <= totalPages }
}
```

```ts mutant
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.ceil(items.length / pageSize)
  const current = Math.max(1, page)
  const start = (current - 1) * pageSize
  return { items: items.slice(start, start + pageSize), page: current, totalPages, hasPrev: current > 1, hasNext: current < totalPages }
}
```

```ts starter
test('first page', () => {
  const r = paginate([1, 2, 3, 4, 5, 6, 7], 1, 3)
  expect(r.page).toBe(1)
})
```

```ts solution
const seven = [1, 2, 3, 4, 5, 6, 7]
test('first and middle pages contain the right items', () => {
  expect(paginate(seven, 1, 3).items).toEqual([1, 2, 3])
  expect(paginate(seven, 2, 3).items).toEqual([4, 5, 6])
})
test('a partial last page counts as a page', () => {
  const r = paginate(seven, 3, 3)
  expect(r.totalPages).toBe(3)
  expect(r.items).toEqual([7])
})
test('hasPrev / hasNext', () => {
  expect(paginate(seven, 1, 3)).toMatchObject({ hasPrev: false, hasNext: true })
  expect(paginate(seven, 3, 3)).toMatchObject({ hasPrev: true, hasNext: false })
})
test('out-of-range pages are clamped', () => {
  expect(paginate(seven, 99, 3)).toMatchObject({ page: 3, items: [7] })
  expect(paginate(seven, 0, 3).page).toBe(1)
})
test('an empty list has one empty page', () => {
  expect(paginate([], 1, 10)).toEqual({ items: [], page: 1, totalPages: 1, hasPrev: false, hasNext: false })
})
```
:::

### Testing a form

Form tests follow the same recipe: find fields by **label**, type like a user, submit, and assert on (a) visible
messages and (b) the callback the component reports to its parent. Pass a mock function as the callback and
check it with `toHaveBeenCalledWith` — and just as important, `not.toHaveBeenCalled()` for invalid input.

:::challenge id=fe-22-c2 lang=tsx mode=tests xp=70
title: Test the login form
`LoginForm` validates and calls `onSubmit({ email, password })`. Write tests that catch the four hidden bugs. Think
about: what is sent (exactly), when nothing must be sent, how errors are announced, and the password rule's edge.

hint: `const onSubmit = fn()` then `render(<LoginForm onSubmit={onSubmit} />)`.
hint: `await user.type(screen.getByLabelText('Email'), '  ada@example.com ')` — note the spaces.
hint: Errors use `role="alert"` so screen readers announce them: `screen.getByRole('alert')`.
hint: The rule is "at least 8 characters" — try exactly 7 and exactly 8.

```tsx impl
import { useState } from 'react'

export function LoginForm({ onSubmit }: { onSubmit: (v: { email: string; password: string }) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return setError('Email is required')
    if (password.length < 8) return setError('Password must be at least 8 characters')
    setError('')
    onSubmit({ email: email.trim(), password })
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Sign in">
      <label htmlFor="login-email">Email</label>
      <input id="login-email" type="text" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="login-password">Password</label>
      <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  )
}
```

```tsx mutant
import { useState } from 'react'

export function LoginForm({ onSubmit }: { onSubmit: (v: { email: string; password: string }) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return setError('Email is required')
    if (password.length < 8) return setError('Password must be at least 8 characters')
    setError('')
    onSubmit({ email, password })
  }
  return (
    <form onSubmit={handleSubmit} aria-label="Sign in">
      <label htmlFor="login-email">Email</label>
      <input id="login-email" type="text" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="login-password">Password</label>
      <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  )
}
```

```tsx mutant
import { useState } from 'react'

export function LoginForm({ onSubmit }: { onSubmit: (v: { email: string; password: string }) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return setError('Email is required')
    if (password.length < 6) return setError('Password must be at least 8 characters')
    setError('')
    onSubmit({ email: email.trim(), password })
  }
  return (
    <form onSubmit={handleSubmit} aria-label="Sign in">
      <label htmlFor="login-email">Email</label>
      <input id="login-email" type="text" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="login-password">Password</label>
      <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  )
}
```

```tsx mutant
import { useState } from 'react'

export function LoginForm({ onSubmit }: { onSubmit: (v: { email: string; password: string }) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) setError('Email is required')
    else if (password.length < 8) setError('Password must be at least 8 characters')
    else setError('')
    onSubmit({ email: email.trim(), password })
  }
  return (
    <form onSubmit={handleSubmit} aria-label="Sign in">
      <label htmlFor="login-email">Email</label>
      <input id="login-email" type="text" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="login-password">Password</label>
      <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  )
}
```

```tsx mutant
import { useState } from 'react'

export function LoginForm({ onSubmit }: { onSubmit: (v: { email: string; password: string }) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return setError('Email is required')
    if (password.length < 8) return setError('Password must be at least 8 characters')
    setError('')
    onSubmit({ email: email.trim(), password })
  }
  return (
    <form onSubmit={handleSubmit} aria-label="Sign in">
      <label htmlFor="login-email">Email</label>
      <input id="login-email" type="text" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="login-password">Password</label>
      <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  )
}
```

```tsx starter
test('renders a sign-in button', () => {
  render(<LoginForm onSubmit={fn()} />)
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
})
```

```tsx solution
test('submits the trimmed email and the password', async () => {
  const onSubmit = fn()
  render(<LoginForm onSubmit={onSubmit} />)
  await user.type(screen.getByLabelText('Email'), '  ada@example.com ')
  await user.type(screen.getByLabelText('Password'), '12345678')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(onSubmit).toHaveBeenCalledWith({ email: 'ada@example.com', password: '12345678' })
  expect(screen.queryByRole('alert')).toBeNull()
})
test('requires an email and does not submit', async () => {
  const onSubmit = fn()
  render(<LoginForm onSubmit={onSubmit} />)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Email is required')
  expect(onSubmit).not.toHaveBeenCalled()
})
test('a 7-character password is rejected', async () => {
  const onSubmit = fn()
  render(<LoginForm onSubmit={onSubmit} />)
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  await user.type(screen.getByLabelText('Password'), '1234567')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters')
  expect(onSubmit).not.toHaveBeenCalled()
})
```
:::

## Async UI and mocking the network

Components that fetch data need two things in tests: a way to **control the response**, and **async queries**
that wait for the UI to update.

**Option 1 — inject the dependency** (best when you control the design). If the component or hook receives a
`loadUser` function or a service (as in the modular-architecture lesson), the test passes a mock:

```tsx
const loadUser = vi.fn().mockResolvedValue({ id: 1, name: 'Ada' })
render(<UserCard userId={1} loadUser={loadUser} />)
expect(await screen.findByRole('heading', { name: 'Ada' })).toBeInTheDocument()
```

**Option 2 — spy on `fetch`** for code that calls it directly:

```ts
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 1, name: 'Ada' }))
})
afterEach(() => vi.restoreAllMocks())
```

Note `mockImplementation` creating a **new** `Response` per call. A common mistake is
`mockResolvedValue(new Response(...))`: every call then gets the *same* object, and a response body can be read only
once, so the second `fetch` in the test fails with "Body is unusable / body already read".

**Option 3 — Mock Service Worker (MSW)**, the industry favourite for feature tests. MSW intercepts requests at the
network level, so your real `fetch`/axios/TanStack Query code runs unchanged, and the same handlers power Storybook and local dev:

```ts
// src/test/server.ts
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

export const server = setupServer(
  http.get('/api/users/:id', ({ params }) => HttpResponse.json({ id: Number(params.id), name: 'Ada' })),
)
// setup.ts: beforeAll(() => server.listen({ onUnhandledRequest: 'error' })); afterEach(() => server.resetHandlers()); afterAll(() => server.close())

// in a test — override for the error case
server.use(http.get('/api/users/:id', () => new HttpResponse(null, { status: 500 })))
```

`onUnhandledRequest: 'error'` makes any request without a handler fail loudly instead of silently hitting the
real network, and `resetHandlers()` removes per-test `server.use` overrides so they can't leak into the next test.

:::warn title="Relative URLs in Node"
In Vitest, `fetch` is Node's implementation, which needs an **absolute** URL: `fetch('/api/users/1')` throws
`Failed to parse URL`. Build API URLs from a base (`new URL('/api/users/1', location.origin)` — jsdom provides
`location` — or an `apiBaseUrl` from config). MSW handlers written with relative paths like `'/api/users/:id'`
are matched against `location.origin`, so they keep working.
:::

Then use `findBy…` (or `await waitFor(() => expect(…))`) for anything that appears after a promise settles.
`findBy` polls every 50 ms for up to 1 s by default (override with `findByText('Saved', {}, { timeout: 3000 })`).
Never `await sleep(500)` — it's slow *and* flaky.

:::pro title="Test the unhappy paths"
Happy-path tests are the ones everybody writes. The bugs that reach production live in the others: the 500
response, the empty list, the slow request whose result arrives after the user navigated away, the user id that
changes while a request is in flight. A senior reviewer will ask "what happens when this fails?" — have a test that answers it.
:::

:::challenge id=fe-22-c3 lang=tsx mode=tests xp=80
title: Test an async component
`UserCard({ userId, loadUser })` shows `Loading…`, then the user's name as a heading and their email. If loading
fails it shows an alert `Could not load user`. When `userId` changes it loads the new user. Catch all four hidden bugs.

hint: `const loadUser = fn((id: number) => Promise.resolve({ name: id === 1 ? 'Ada' : 'Grace', email: 'x@y.z' }))`
hint: For the failure case: `fn(() => Promise.reject(new Error('500')))` and `await screen.findByRole('alert')`.
hint: `render` returns `rerender` — `rerender(<UserCard userId={2} loadUser={loadUser} />)`.
hint: Is `Loading…` visible straight after `render`? Was `loadUser` called with the right id?

```tsx impl
import { useEffect, useState } from 'react'

type User = { name: string; email: string }

export function UserCard({ userId, loadUser }: { userId: number; loadUser: (id: number) => Promise<User> }) {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; user?: User }>({ status: 'loading' })
  useEffect(() => {
    let ignore = false
    setState({ status: 'loading' })
    loadUser(userId).then(
      (user) => { if (!ignore) setState({ status: 'ok', user }) },
      () => { if (!ignore) setState({ status: 'error' }) },
    )
    return () => { ignore = true }
  }, [userId, loadUser])

  if (state.status === 'loading') return <p>Loading…</p>
  if (state.status === 'error') return <p role="alert">Could not load user</p>
  return (
    <article>
      <h3>{state.user!.name}</h3>
      <p>{state.user!.email}</p>
    </article>
  )
}
```

```tsx mutant
import { useEffect, useState } from 'react'

type User = { name: string; email: string }

export function UserCard({ userId, loadUser }: { userId: number; loadUser: (id: number) => Promise<User> }) {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; user?: User }>({ status: 'loading' })
  useEffect(() => {
    let ignore = false
    loadUser(userId).then(
      (user) => { if (!ignore) setState({ status: 'ok', user }) },
      () => {},
    )
    return () => { ignore = true }
  }, [userId, loadUser])
  if (state.status === 'loading') return <p>Loading…</p>
  if (state.status === 'error') return <p role="alert">Could not load user</p>
  return <article><h3>{state.user!.name}</h3><p>{state.user!.email}</p></article>
}
```

```tsx mutant
import { useEffect, useState } from 'react'

type User = { name: string; email: string }

export function UserCard({ userId, loadUser }: { userId: number; loadUser: (id: number) => Promise<User> }) {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; user?: User }>({ status: 'loading' })
  useEffect(() => {
    let ignore = false
    loadUser(userId).then(
      (user) => { if (!ignore) setState({ status: 'ok', user }) },
      () => { if (!ignore) setState({ status: 'error' }) },
    )
    return () => { ignore = true }
  }, [])
  if (state.status === 'loading') return <p>Loading…</p>
  if (state.status === 'error') return <p role="alert">Could not load user</p>
  return <article><h3>{state.user!.name}</h3><p>{state.user!.email}</p></article>
}
```

```tsx mutant
import { useEffect, useState } from 'react'

type User = { name: string; email: string }

export function UserCard({ userId, loadUser }: { userId: number; loadUser: (id: number) => Promise<User> }) {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; user?: User }>({ status: 'loading' })
  useEffect(() => {
    let ignore = false
    setState({ status: 'loading' })
    loadUser(userId).then(
      (user) => { if (!ignore) setState({ status: 'ok', user }) },
      () => { if (!ignore) setState({ status: 'error' }) },
    )
    return () => { ignore = true }
  }, [userId, loadUser])
  if (state.status === 'loading') return null
  if (state.status === 'error') return <p role="alert">Could not load user</p>
  return <article><h3>{state.user!.name}</h3><p>{state.user!.email}</p></article>
}
```

```tsx mutant
import { useEffect, useState } from 'react'

type User = { name: string; email: string }

export function UserCard({ userId, loadUser }: { userId: number; loadUser: (id: number) => Promise<User> }) {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; user?: User }>({ status: 'loading' })
  useEffect(() => {
    let ignore = false
    setState({ status: 'loading' })
    loadUser(1).then(
      (user) => { if (!ignore) setState({ status: 'ok', user }) },
      () => { if (!ignore) setState({ status: 'error' }) },
    )
    return () => { ignore = true }
  }, [userId, loadUser])
  if (state.status === 'loading') return <p>Loading…</p>
  if (state.status === 'error') return <p role="alert">Could not load user</p>
  return <article><h3>{state.user!.name}</h3><p>{state.user!.email}</p></article>
}
```

```tsx starter
test('shows the user', async () => {
  const loadUser = fn(() => Promise.resolve({ name: 'Ada', email: 'ada@example.com' }))
  render(<UserCard userId={1} loadUser={loadUser} />)
  expect(await screen.findByText('ada@example.com')).toBeInTheDocument()
})
```

```tsx solution
const users: Record<number, { name: string; email: string }> = {
  1: { name: 'Ada', email: 'ada@example.com' },
  2: { name: 'Grace', email: 'grace@example.com' },
}
test('shows loading, then the user', async () => {
  const loadUser = fn((id: number) => Promise.resolve(users[id]))
  render(<UserCard userId={2} loadUser={loadUser} />)
  expect(screen.getByText('Loading…')).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'Grace' })).toBeInTheDocument()
  expect(screen.getByText('grace@example.com')).toBeInTheDocument()
  expect(loadUser).toHaveBeenCalledWith(2)
})
test('shows an alert when loading fails', async () => {
  const loadUser = fn(() => Promise.reject(new Error('500')))
  render(<UserCard userId={1} loadUser={loadUser} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load user')
})
test('loads the new user when userId changes', async () => {
  const loadUser = fn((id: number) => Promise.resolve(users[id]))
  const { rerender } = render(<UserCard userId={1} loadUser={loadUser} />)
  await screen.findByRole('heading', { name: 'Ada' })
  rerender(<UserCard userId={2} loadUser={loadUser} />)
  expect(await screen.findByRole('heading', { name: 'Grace' })).toBeInTheDocument()
})
```
:::

## Testing hooks

Most hooks are best tested **through a component that uses them** — that's how they're used in reality. For
reusable hooks (a `useDebounce`, `useLocalStorage`, `useCounter` in your shared library), React Testing Library has
`renderHook`:

```ts
import { renderHook, act } from '@testing-library/react'

test('increments', () => {
  const { result } = renderHook(() => useCounter({ initial: 5 }))
  act(() => result.current.increment())
  expect(result.current.count).toBe(6)
})
```

`result.current` always holds the latest return value. Wrap state-changing calls in `act` so React flushes the
update before you assert. If the hook needs context (a QueryClient, a router), pass `{ wrapper: Providers }`.

An equally valid approach — and the one available in this sandbox — is a tiny **test harness component** that
renders the hook's values and exposes its functions as buttons. It doubles as documentation of the hook's API.

:::challenge id=fe-22-c4 lang=tsx mode=tests xp=70
title: Test a hook through a harness
`useCounter({ initial = 0, min, max, step = 1 })` returns `{ count, increment, decrement, reset }`. Increments and
decrements move by `step` and are clamped to `min`/`max`; `reset` goes back to `initial`. The starter gives you a
`CounterHarness` component — write tests that catch all four bugs.

hint: Render `<CounterHarness initial={5} max={6} />` and click `+` twice: the count must stop at 6.
hint: Don't forget `min`, `step` and what `reset` returns to (is it 0 or `initial`?).

```tsx impl
import { useState } from 'react'

export function useCounter({ initial = 0, min = -Infinity, max = Infinity, step = 1 }: { initial?: number; min?: number; max?: number; step?: number } = {}) {
  const [count, setCount] = useState(initial)
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return {
    count,
    increment: () => setCount((c) => clamp(c + step)),
    decrement: () => setCount((c) => clamp(c - step)),
    reset: () => setCount(initial),
  }
}
```

```tsx mutant
import { useState } from 'react'

export function useCounter({ initial = 0, min = -Infinity, max = Infinity, step = 1 }: { initial?: number; min?: number; max?: number; step?: number } = {}) {
  const [count, setCount] = useState(initial)
  const clamp = (n: number) => Math.max(min, n)
  return { count, increment: () => setCount((c) => clamp(c + step)), decrement: () => setCount((c) => clamp(c - step)), reset: () => setCount(initial) }
}
```

```tsx mutant
import { useState } from 'react'

export function useCounter({ initial = 0, min = -Infinity, max = Infinity, step = 1 }: { initial?: number; min?: number; max?: number; step?: number } = {}) {
  const [count, setCount] = useState(initial)
  const clamp = (n: number) => Math.min(max, n)
  return { count, increment: () => setCount((c) => clamp(c + step)), decrement: () => setCount((c) => clamp(c - step)), reset: () => setCount(initial) }
}
```

```tsx mutant
import { useState } from 'react'

export function useCounter({ initial = 0, min = -Infinity, max = Infinity, step = 1 }: { initial?: number; min?: number; max?: number; step?: number } = {}) {
  const [count, setCount] = useState(initial)
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return { count, increment: () => setCount((c) => clamp(c + 1)), decrement: () => setCount((c) => clamp(c - 1)), reset: () => setCount(initial) }
}
```

```tsx mutant
import { useState } from 'react'

export function useCounter({ initial = 0, min = -Infinity, max = Infinity, step = 1 }: { initial?: number; min?: number; max?: number; step?: number } = {}) {
  const [count, setCount] = useState(initial)
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return { count, increment: () => setCount((c) => clamp(c + step)), decrement: () => setCount((c) => clamp(c - step)), reset: () => setCount(0) }
}
```

```tsx starter
function CounterHarness(props: { initial?: number; min?: number; max?: number; step?: number }) {
  const { count, increment, decrement, reset } = useCounter(props)
  return (
    <div>
      <output aria-label="count">{count}</output>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
      <button onClick={reset}>Reset</button>
    </div>
  )
}

test('starts at initial', () => {
  render(<CounterHarness initial={3} />)
  expect(screen.getByLabelText('count')).toHaveTextContent('3')
})
```

```tsx solution
function CounterHarness(props: { initial?: number; min?: number; max?: number; step?: number }) {
  const { count, increment, decrement, reset } = useCounter(props)
  return (
    <div>
      <output aria-label="count">{count}</output>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
      <button onClick={reset}>Reset</button>
    </div>
  )
}
const count = () => screen.getByLabelText('count')

test('increments up to max and no further', async () => {
  render(<CounterHarness initial={5} max={6} />)
  await user.click(screen.getByRole('button', { name: '+' }))
  await user.click(screen.getByRole('button', { name: '+' }))
  expect(count()).toHaveTextContent('6')
})
test('decrements down to min and no further', async () => {
  render(<CounterHarness initial={1} min={0} />)
  await user.click(screen.getByRole('button', { name: '-' }))
  await user.click(screen.getByRole('button', { name: '-' }))
  expect(count()).toHaveTextContent('0')
})
test('moves by step', async () => {
  render(<CounterHarness step={5} />)
  await user.click(screen.getByRole('button', { name: '+' }))
  expect(count()).toHaveTextContent('5')
})
test('reset returns to initial', async () => {
  render(<CounterHarness initial={3} />)
  await user.click(screen.getByRole('button', { name: '+' }))
  await user.click(screen.getByRole('button', { name: 'Reset' }))
  expect(count()).toHaveTextContent('3')
})
```
:::

## Time: debounce, timeouts and fake timers

A search box that waits 300 ms after the last keystroke, a toast that disappears after 5 s, a session warning after
15 minutes — you don't want tests that actually wait. **Fake timers** replace `setTimeout`, `setInterval` and
`Date` with a clock *you* move forward:

```tsx
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())          // never leak a frozen clock into the next test

test('searches 300 ms after the user stops typing', async () => {
  // user-event waits between keystrokes with setTimeout — tell it how to move the fake clock
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  const onSearch = vi.fn()
  render(<SearchBox onSearch={onSearch} />)

  await user.type(screen.getByRole('searchbox'), 'ada')
  expect(onSearch).not.toHaveBeenCalled()      // debounce still pending

  await act(() => vi.advanceTimersByTimeAsync(300))
  expect(onSearch).toHaveBeenCalledTimes(1)
  expect(onSearch).toHaveBeenCalledWith('ada')
})
```

Why each piece is there:

- **`advanceTimers` option** — without it, `await user.type(...)` never finishes: user-event schedules its
  delays on the clock you just froze, so the test hangs until it times out.
- **`act(...)` around advancing** — firing the timer calls `setState` outside any Testing Library helper, so
  wrap it to let React flush the update.
- **`advanceTimersByTimeAsync`** (not the sync version) — also flushes promise callbacks scheduled by the timers.
- **`useRealTimers` in `afterEach`** — `findBy`/`waitFor` poll with timers too; a frozen clock left behind makes
  unrelated tests hang.

:::quiz id=fe-22-q6 xp=10
After adding `vi.useFakeTimers()` to a test file, a previously green test that does `await user.click(...)` now
times out after 5 s. What is the most likely cause?
- [x] `userEvent.setup()` was not given `advanceTimers: vi.advanceTimersByTime`, so its internal delays wait on the frozen clock
- [ ] Fake timers disable DOM events in jsdom
- [ ] `user.click` must be replaced with `fireEvent.click` whenever fake timers are on
- [ ] The test needs `await sleep(100)` to let the fake clock catch up
> user-event yields between the steps of an interaction via `setTimeout`; with fake timers that timeout never fires
> unless user-event knows how to advance the clock. DOM events still work fine. Swapping to `fireEvent` "fixes" the
> hang but throws away the realistic event sequence, and a real-time `sleep` can't move a fake clock at all.
:::

## What NOT to test

Every test is code you maintain. Tests that don't protect behaviour are pure cost. Skip:

- **Implementation details** — the value of a state variable, which hook was used, that a private helper was
  called, internal component names. These change during refactors while behaviour stays the same.
- **CSS classes and inline styles** as a proxy for behaviour (`toHaveClass('active')`). Prefer what users and
  assistive tech perceive: `aria-selected`, `aria-expanded`, `aria-current`, visible text, `toBeDisabled()`.
- **The framework and libraries** — that React renders, that `useState` updates, that React Router navigates.
  Test *your* use of them.
- **Huge snapshots.** `expect(container).toMatchSnapshot()` of a whole page breaks on every markup tweak, and
  reviewers just press "update". Small, targeted inline snapshots of serialised data (an error message, a generated
  URL) are fine.
- **Trivial code** — a component that only renders its props, type definitions, constants.

What *to* test, in priority order: business rules (reducers, validators, calculations), user flows of a feature
(happy + unhappy paths), accessibility contracts (roles, labels, keyboard), and every bug you fix (a regression test first, then the fix).

:::quiz id=fe-22-q2 xp=15
Which of these tests are likely **worth keeping**? (Select all that apply.)
- [x] "Submitting the form with an invalid email shows an error and does not call the API"
- [ ] "`useState` is called twice in `ProfilePage`"
- [x] "Pressing Escape closes the dialog and returns focus to the trigger button"
- [ ] "The whole settings page matches the stored 600-line snapshot"
- [x] "`cartReducer` removes an item when its quantity is set to 0"
> Keep tests that describe behaviour a user or a business rule cares about: validation, keyboard/focus behaviour,
> and a reducer rule. The `useState` count is an implementation detail — switching to `useReducer` would break the
> test while the page behaves identically. A 600-line snapshot fails on every harmless markup tweak and gets
> blindly updated, so it protects nothing.
:::

:::quiz id=fe-22-q3 xp=10
A test passes locally but fails ~1 in 10 runs in CI. It clicks "Save", then immediately asserts
`expect(screen.getByText('Saved')).toBeInTheDocument()`. The Save handler awaits an API call. What's the best fix?
- [ ] Add `await sleep(1000)` before the assertion
- [ ] Retry the test 3 times in CI
- [x] Use `expect(await screen.findByText('Saved')).toBeInTheDocument()`
- [ ] Use `getByTestId` instead of `getByText`
> The text appears only after a promise resolves; `findBy…` waits (polling) until it's there, up to a timeout, and
> continues the moment it appears. A sleep makes every run 1 s slower and still fails on a runner that is slower
> than 1 s; retries hide the race instead of fixing it. `getByTestId` changes *how* the element is found, not
> *when* — it has the same race.
:::

:::job title="Tests in a real team"
Expect CI to run `vitest run` (often with `--coverage` and a threshold) on every PR, and reviewers to ask "where's
the test?" for any bug fix. Common conventions: `*.test.tsx` colocated with the component; a `src/test/` folder
with `setup.ts`, MSW handlers and a `renderWithProviders()` helper that wraps components in the QueryClient, router
and theme providers the app uses. Learn that helper on day one — every feature test uses it.
:::

## Recap

- Test **behaviour**, the way users experience it — resilient to refactors.
- Setup: `vitest` + `jsdom` + `@testing-library/react` + `user-event` + `jest-dom`, configured in `vite.config.ts`
  with a `setupFiles` entry.
- Query priority: **`getByRole`** (with `name`) → `getByLabelText` → `getByText` → … → `getByTestId` last.
  `getBy` = must exist now, `queryBy` = assert absence, `findBy` = wait for async UI.
- Drive the UI with **`await user.click/type/keyboard`**, never forget `await`.
- Mock at the boundary: inject a fake service, `vi.spyOn(globalThis, 'fetch')`, or **MSW** for realistic network mocking.
- Test hooks through components or with `renderHook` + `act`.
- `act` flushes React updates; Testing Library calls it for you — a "not wrapped in act" warning usually means a
  missing `await`.
- Fake timers for debounce/timeouts: `vi.useFakeTimers()`, `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`,
  advance inside `act`, restore real timers after each test.
- Don't test implementation details, CSS classes, libraries or giant snapshots. Mutation thinking — "would a bug
  make this fail?" — is the real quality bar.

:::cards id=fe-22-cards1 xp=15 title="Testing React"
Q: getBy vs queryBy vs findBy?
A: getBy throws if missing (sync). queryBy returns null (assert absence). findBy returns a promise that retries until found (async UI).
Q: Top query in the priority list, and why?
A: `getByRole` with `name` — it mirrors how assistive technology finds elements, so it also checks accessibility.
Q: How do you find a password input?
A: `getByLabelText('Password')` — password inputs have no ARIA role.
Q: Why `user-event` over `fireEvent`?
A: It simulates the full interaction sequence (focus, keydown, input, keyup, click…) like a real browser.
Q: Three ways to mock the network?
A: Inject a fake service/function, `vi.spyOn(globalThis, 'fetch')`, or MSW handlers that intercept requests.
Q: What does `renderHook` give you?
A: `result.current` — the hook's latest return value. Wrap updates in `act`.
Q: What is mutation testing?
A: Deliberately introducing bugs (mutants) and checking that at least one test fails for each — a measure of test quality.
Q: Why avoid `await sleep(500)` in tests?
A: Slow and still flaky. Wait for the condition instead: `findBy…` or `waitFor`.
Q: What does `act()` do?
A: Runs the callback and flushes every resulting React render and effect before returning, so assertions see the final UI.
Q: Why does `await user.type` hang after `vi.useFakeTimers()`?
A: user-event waits with `setTimeout`; pass `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`.
:::
