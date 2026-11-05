---
id: fe-03
title: TypeScript Essentials
level: beginner
minutes: 35
xp: 110
summary: Types, interfaces vs type aliases, unions, literal types, narrowing, optional properties, typed functions, and why `unknown` beats `any`.
---

TypeScript is JavaScript plus a **static type checker**. You describe the shape of your data, and
the compiler checks — before the code ever runs — that you use it consistently. Then the types
are **erased**: the browser runs plain JavaScript. That one fact explains a lot:

- Types cost nothing at runtime, but also **protect nothing at runtime**. Data from an API, `localStorage` or a form is whatever it is, no matter what you declared.
- The payoff is in the editor: autocompletion, safe renames, and "you forgot to handle `null`" errors while you type instead of in production.

Virtually every React job posting today says "TypeScript". In real codebases it's not optional
decoration — it's how a team of 10 changes a 200-file app without breaking it.

:::info title="How the challenges in this lesson work"
The sandbox strips types and runs the JavaScript, just like Vite does (Vite never type-checks — your
editor and `tsc --noEmit` in CI do). So the code challenges test **runtime behaviour**: narrowing,
handling `unknown`, defaults. The quizzes test what the type checker would say.
:::

## Basic types and inference

```ts
let title: string = 'Dune'
let pages: number = 412           // integers and floats alike
let inStock: boolean = true
let tags: string[] = ['sci-fi']    // or Array<string>
let pair: [string, number] = ['age', 42]   // tuple: fixed length & positions
let nothing: null = null
let notSet: undefined = undefined
```

You rarely need to write these annotations. TypeScript **infers** types from values:

```ts
let count = 0            // number
const name = 'Ada'       // "Ada"  (a literal type — const can never change)
const nums = [1, 2, 3]   // number[]
const user = { id: 1, name: 'Ada' }   // { id: number; name: string }
```

The rule of thumb on real teams: **annotate function parameters and public APIs; let inference
do the rest.** Annotating every local variable is noise.

:::quiz id=fe-03-q1 xp=10
Which line does the TypeScript compiler reject?

```ts
let total = 10           // line 1
total = total + 5        // line 2
total = '15'             // line 3
const items = []         // line 4
```

- [ ] Line 2
- [x] Line 3
- [ ] Line 4
- [ ] None — TypeScript only warns
> `total` was inferred as `number` from its initial value, so assigning a string is a compile
> error: *Type 'string' is not assignable to type 'number'*. Once inferred, a variable's type is
> fixed — inference is not "dynamic typing". (Line 4 is allowed — under `strict` an empty array
> literal starts as an "evolving" array whose type grows with what you push; clearer to write
> `const items: string[] = []`.) It is a real error, not a warning — `tsc` exits non-zero and CI
> fails.
:::

## Object types: `interface` and `type`

```ts
interface User {
  id: number
  name: string
  email?: string          // optional: string | undefined
  readonly createdAt: Date  // can't be reassigned after creation
}

type Product = {
  id: number
  title: string
  price: number
}

function greet(user: User): string {
  return `Hi ${user.name}`
}
```

Both give a **name** to a shape so you can reuse it. `interface` declares an object type;
`type` is an **alias** — a name for *any* type expression. TypeScript is **structurally typed**:
a value fits a type if it has the right properties, no matter which name it was declared with or
whether it was "created" as that type:

```ts
const ada = { id: 1, name: 'Ada', createdAt: new Date() }
greet(ada)   // ✅ ada has every property User requires — no "implements" needed
greet({ id: 2, name: 'Bob', createdAt: new Date(), age: 30 })
// ❌ Object literal may only specify known properties ('age') — the "excess property check"
//    catches typos when you pass a *fresh* object literal directly
```

`interface` and `type` aliases are mostly interchangeable for object shapes. The differences:

| | `interface` | `type` |
|---|---|---|
| Object shapes | ✅ | ✅ |
| Extending | `interface Admin extends User { … }` | `type Admin = User & { … }` (intersection) |
| Unions, primitives, tuples | ❌ | ✅ `type Id = string \| number` |
| Declaration merging (two declarations combine) | ✅ (used to augment libraries) | ❌ error |

:::job title="Which one do teams use?"
Both, and the debate is mostly bikeshedding. A common convention: `type` for everything (since
only `type` can express unions), or `interface` for object shapes and `type` for unions. Follow the
existing code base — consistency beats preference. In React code you'll very often see
`type ButtonProps = { … }`.
:::

## Union and literal types

A **union** says "one of these":

```ts
type Id = string | number

type Status = 'idle' | 'loading' | 'success' | 'error'   // union of string literal types
let status: Status = 'idle'
status = 'done'   // ❌ Type '"done"' is not assignable to type 'Status'
```

A **literal type** is a type with exactly one value: `'idle'` the *type* only accepts the string
`'idle'`. Combine literals with `|` and you get a closed list of allowed values.

Literal unions are TypeScript's lightweight enums: autocompletion lists the valid values and typos
become compile errors. Most teams prefer them over the `enum` keyword, because `enum` is one of the
few TypeScript features that **generates runtime code** — it doesn't fit the "types are simply
erased" model. Node's built-in type stripping refuses it, and the `erasableSyntaxOnly` compiler
option (TS 5.8+, on in Vite's current templates) turns it into an error.

```ts
// instead of: enum Status { Idle, Loading }
const STATUSES = ['idle', 'loading', 'success', 'error'] as const   // a runtime list, if you need one
type Status = (typeof STATUSES)[number]                            // 'idle' | 'loading' | …
```

## Narrowing

With a union you may only use what *all* members have. To use the specific parts, you **narrow**:
you write a runtime check, and TypeScript understands that inside the branch the type is more
specific.

```ts
function formatId(id: string | number) {
  // id.toUpperCase()  ❌ — number has no toUpperCase
  if (typeof id === 'string') {
    return id.toUpperCase()        // here id: string
  }
  return id.toFixed(0)             // here id: number
}
```

The narrowing tools:

| Check | Narrows |
|---|---|
| `typeof x === 'string'` | the `typeof` results: `"string"`, `"number"`, `"boolean"`, `"bigint"`, `"symbol"`, `"undefined"`, `"function"`, `"object"` (also true for `null`!) |
| `x === null`, `x != null`, `if (x)` | removes `null`/`undefined` (truthiness also removes `0`/`''`!) |
| `Array.isArray(x)` | arrays |
| `x instanceof Date` | class instances |
| `'email' in x` | objects that have that property |
| `x.kind === 'circle'` | discriminated unions (next lesson) |

:::warn title="Narrowing must be a real runtime check"
TypeScript only narrows on checks that also exist in the emitted JavaScript. `typeof x === 'object'`
is also true for `null` (a historic JS quirk), so write `typeof x === 'object' && x !== null`. And
`typeof` can't tell *your* types apart: `typeof user === 'User'` is never true — types don't
exist at runtime.
:::

:::challenge id=fe-03-c1 lang=ts xp=30
title: Narrow an id
Order ids come from two systems: legacy numeric ids and new string ids. Write `formatOrderId(id)`:

- number → `#` + the number padded to 6 digits: `42` → `#000042`
- string → `#` + the trimmed, upper-cased string: `' ab-12 '` → `#AB-12`

hint: `typeof id === 'number'` narrows to `number`.
hint: `String(id).padStart(6, '0')`

```ts starter
export function formatOrderId(id: string | number): string {
  return '#' + id
}
```

```ts solution
export function formatOrderId(id: string | number): string {
  if (typeof id === 'number') {
    return '#' + String(id).padStart(6, '0')
  }
  return '#' + id.trim().toUpperCase()
}
```

```ts tests
test('pads numbers', () => {
  expect(formatOrderId(42)).toBe('#000042')
})
test('keeps long numbers', () => {
  expect(formatOrderId(1234567)).toBe('#1234567')
})
test('normalises strings', () => {
  expect(formatOrderId(' ab-12 ')).toBe('#AB-12')
})
```
:::

## Optional and nullable values

`strictNullChecks` (part of `"strict": true`) makes `null` and `undefined` their own types. That's
the feature that kills "Cannot read properties of undefined". Since TypeScript 6, `strict` is on by
default; you'll still see `"strict": true` written explicitly in every tsconfig, and older code
bases on TS 5 may have it off.

```ts
interface Profile {
  displayName?: string          // may be missing → string | undefined
  avatarUrl: string | null      // must be present, but may be null
}

function avatarOf(p: Profile) {
  return p.avatarUrl ?? '/default.png'
}

function shout(p: Profile) {
  // return p.displayName.toUpperCase()  ❌ 'p.displayName' is possibly 'undefined'
  return p.displayName?.toUpperCase() ?? 'ANONYMOUS'
}
```

The `!` **non-null assertion** (`p.displayName!.toUpperCase()`) tells the compiler "trust me, it's
there". It doesn't check anything at runtime — if you're wrong, it crashes just like plain JS. Treat
every `!` in a code review as a question: *why are we sure?*

## Typing functions

```ts
// parameter and return types
function add(a: number, b: number): number {
  return a + b
}

// optional and default parameters
function paginate(items: string[], page = 1, size?: number) { /* size: number | undefined */ }

// function types (very common for callbacks and props)
type Formatter = (value: number) => string
const euro: Formatter = (v) => `${v.toFixed(2)} €`   // v is inferred as number

// a callback parameter
function onEach(items: string[], cb: (item: string, index: number) => void) {
  items.forEach(cb)
}
```

Annotating the **return type** of exported functions is a good habit: if you accidentally return
`undefined` from one branch, the error appears in the function, not in 12 callers.

`void` means "the return value isn't used". `never` means "this function never returns" (it
throws or loops forever) — you'll use it for exhaustiveness checks in the next lesson.

:::challenge id=fe-03-c2 lang=ts xp=30
title: Display names with optional fields
Write `displayName(user)` for this type:

```ts
interface User {
  firstName: string
  lastName?: string
  nickname?: string | null
}
```

- If `nickname` is a non-empty string (after trimming), return it trimmed.
- Otherwise return `firstName` + ` ` + `lastName`, or just `firstName` when there's no last name.

hint: `const nick = user.nickname?.trim()` is `string | undefined`.
hint: `if (nick) return nick` — here truthiness is exactly what we want, because `''` should be skipped.

```ts starter
interface User {
  firstName: string
  lastName?: string
  nickname?: string | null
}

export function displayName(user: User): string {
  return user.firstName + ' ' + user.lastName
}
```

```ts solution
interface User {
  firstName: string
  lastName?: string
  nickname?: string | null
}

export function displayName(user: User): string {
  const nick = user.nickname?.trim()
  if (nick) return nick
  return user.lastName ? `${user.firstName} ${user.lastName}` : user.firstName
}
```

```ts tests
test('full name', () => {
  expect(displayName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace')
})
test('first name only', () => {
  expect(displayName({ firstName: 'Ada' })).toBe('Ada')
})
test('nickname wins', () => {
  expect(displayName({ firstName: 'Ada', lastName: 'L', nickname: '  countess ' })).toBe('countess')
})
test('blank or null nickname is ignored', () => {
  expect(displayName({ firstName: 'Ada', nickname: '   ' })).toBe('Ada')
  expect(displayName({ firstName: 'Ada', lastName: 'L', nickname: null })).toBe('Ada L')
})
```
:::

## `any` vs `unknown`

Both mean "could be anything", but they are opposites in safety:

```ts
let a: any = JSON.parse(text)
a.foo.bar.baz()          // compiles. Crashes at runtime if wrong. any switches the checker OFF.

let u: unknown = JSON.parse(text)
u.foo                    // ❌ 'u' is of type 'unknown'
if (typeof u === 'object' && u !== null && 'foo' in u) {
  // now TypeScript lets you look at u.foo (as unknown)
}
```

- `any` **turns off** type checking for that value — and it spreads: anything you derive from an `any` is `any` too.
- `unknown` is the **type-safe top type**: you can hold anything, but you must narrow before using it.

Use `unknown` for anything coming from outside your program: `JSON.parse`, `res.json()`,
`localStorage`, `postMessage`, `catch (err)`. Then validate it.

The trap: `JSON.parse` and `res.json()` are typed to return **`any`** in the standard library
(`Promise<any>` for `res.json()`). So `const user: User = await res.json()` compiles with no
check at all — you have just *asserted* the API shape. Opt in to safety yourself:

```ts
const data: unknown = await res.json()   // now the checker forces you to validate
```

Only the `catch` variable is `unknown` automatically (under `strict`). The next lesson shows
validating responses properly with type guards and Zod.

:::quiz id=fe-03-q2 xp=10
Under `"strict": true`, what is the type of `err` here, and what's the correct way to read a message?

```ts
try {
  await save()
} catch (err) {
  showToast(/* ??? */)
}
```

- [ ] `Error` — use `err.message`
- [ ] `any` — use `err.message`
- [x] `unknown` — use `err instanceof Error ? err.message : String(err)`
> JavaScript can `throw` anything (`throw 'oops'`, `throw 42`), so TypeScript types the catch
> variable as `unknown` (with `useUnknownInCatchVariables`, included in `strict`). Narrow with
> `instanceof Error` before reading `.message`. `Error` is tempting, but TypeScript can't know
> what was thrown; `any` was the old default (before TS 4.4) and lets `err.message` crash when
> someone throws a string.
:::

:::challenge id=fe-03-c3 lang=ts xp=40
title: Parse an unknown value safely
A query string, `localStorage`, or a JSON body gives you `unknown`. Write `parseQuantity(input: unknown): number | null`:

- a finite number → that number, rounded down (`Math.floor`)
- a string that is a number after trimming (`' 3 '`, `'4.9'`) → that number, rounded down
- anything else (`''`, `'abc'`, `NaN`, `Infinity`, `null`, objects, booleans…) → `null`
- negative results → `null` (quantities can't be negative)

hint: Narrow with `typeof input === 'number'` and `typeof input === 'string'`.
hint: `Number('')` is `0`, so reject empty strings explicitly. `Number.isFinite(n)` rejects `NaN` and `Infinity`.

```ts starter
export function parseQuantity(input: unknown): number | null {
  return Number(input)
}
```

```ts solution
export function parseQuantity(input: unknown): number | null {
  let n: number
  if (typeof input === 'number') n = input
  else if (typeof input === 'string' && input.trim() !== '') n = Number(input.trim())
  else return null
  if (!Number.isFinite(n)) return null
  const q = Math.floor(n)
  return q < 0 ? null : q
}
```

```ts tests
test('numbers', () => {
  expect(parseQuantity(3)).toBe(3)
  expect(parseQuantity(4.9)).toBe(4)
})
test('numeric strings', () => {
  expect(parseQuantity(' 3 ')).toBe(3)
  expect(parseQuantity('4.9')).toBe(4)
})
test('rejects junk', () => {
  for (const bad of ['', '   ', 'abc', NaN, Infinity, null, undefined, {}, [], true]) {
    expect(parseQuantity(bad)).toBeNull()
  }
})
test('rejects negatives', () => {
  expect(parseQuantity(-1)).toBeNull()
  expect(parseQuantity('-2')).toBeNull()
})
test('zero is a valid quantity', () => {
  expect(parseQuantity(0)).toBe(0)
  expect(parseQuantity('0')).toBe(0)
})
```
:::

## Literal widening and `const`

```ts
let a = 'GET'        // type: string   (let can change, so TS widens)
const b = 'GET'      // type: "GET"    (const can't change, so it stays literal)

type Method = 'GET' | 'POST'
function request(method: Method) {}

request(b)           // ✅
request(a)           // ❌ Argument of type 'string' is not assignable to parameter of type 'Method'
```

Objects widen their properties too: `const opts = { method: 'GET' }` has type `{ method: string }`.
The next lesson shows the fix (`as const` and `satisfies`).

:::quiz id=fe-03-q3 xp=10
Which of these compile with `type Size = 'sm' | 'md' | 'lg'`? (select all that apply)

```ts
function setSize(s: Size) {}
```

- [x] `setSize('md')`
- [x] `const s = 'lg'; setSize(s)`
- [ ] `let s = 'lg'; setSize(s)`
- [ ] `setSize('xl')`
- [x] `let s: Size = 'sm'; setSize(s)`
> A `const` keeps the literal type `"lg"`. A plain `let` widens to `string`, which isn't assignable
> to `Size` — unless you annotate it as `Size`. `'xl'` is simply not a member of the union.
> TypeScript widens `let` because you *could* later assign `'huge'` to it.
:::

:::quiz id=fe-03-q5 xp=10
Spot the problem. This compiles without errors under `"strict": true`:

```ts
interface User { id: number; name: string }

async function loadUser(id: number): Promise<User> {
  const res = await fetch(`/api/users/${id}`)
  const user: User = await res.json()
  return user
}
```

- [ ] Nothing — TypeScript checks that the JSON matches `User`
- [x] `res.json()` returns `any`, so the `User` annotation is an unchecked assertion; a different API shape crashes later at runtime
- [ ] It doesn't compile: `res.json()` returns `unknown`
- [ ] `Promise<User>` is wrong; async functions must return `User`
> Types are erased, so nothing at runtime compares the JSON with `User`. And `res.json()` is
> declared as `Promise<any>` — `any` is assignable to everything, which is why it compiles. Type
> the result as `unknown` (`const data: unknown = await res.json()`) and validate it (or use a schema library). An async function's return type
> is correctly written as `Promise<User>`.
:::

:::quiz id=fe-03-q6 xp=10
Given this type, which object literals compile? (select all that apply)

```ts
interface Profile {
  displayName?: string
  avatarUrl: string | null
}
```

- [x] `{ avatarUrl: null }`
- [x] `{ displayName: 'Ada', avatarUrl: '/ada.png' }`
- [ ] `{ displayName: 'Ada' }`
- [ ] `{ displayName: null, avatarUrl: null }`
> `?` means the property may be **left out** (it's then `undefined`). `| null` means the property
> **must be there** but may hold `null`. So `avatarUrl` can't be omitted, and `displayName` may be
> missing or a string — but not `null`, because `null` isn't in its type.
:::

:::quiz id=fe-03-q4 xp=10
What is the type of `value` on the marked line?

```ts
function f(value: string | number | null) {
  if (value == null) return
  if (typeof value === 'number') return
  value // ← here
}
```

- [ ] `string | number`
- [x] `string`
- [ ] `string | null`
- [ ] `unknown`
> `value == null` (loose equality) is true for both `null` and `undefined`, so after the first
> `return` `null` is gone. After the second, `number` is gone. TypeScript tracks this
> **control flow** precisely.
:::

## tsconfig in one minute

You'll meet these settings in every project's `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,                  // the important one: strictNullChecks, noImplicitAny, …
    "target": "ES2022",              // which JS syntax the output may use
    "module": "ESNext",
    "moduleResolution": "bundler",   // resolve imports the way Vite does
    "jsx": "react-jsx",              // React 17+ JSX transform, no `import React` needed
    "noEmit": true,                  // Vite builds; tsc only type-checks
    "verbatimModuleSyntax": true,    // type-only imports must say so: import type { User } from './types'
    "erasableSyntaxOnly": true,      // forbid enum/namespace & other syntax that isn't just erasable types
    "noUncheckedIndexedAccess": true // opt-in: arr[i] is T | undefined — catches off-by-one bugs
  }
}
```

`tsconfig.json` allows comments (it's JSONC). Vite's React template splits it into
`tsconfig.app.json` (your `src`) and `tsconfig.node.json` (`vite.config.ts`), and its `build`
script is `tsc -b && vite build` — the type check runs first because **`vite build` alone never
fails on a type error**: it just strips the types.

:::pro title="Team habits"
- Keep `"strict": true` (the default since TS 6); turning it on later in a big legacy code base costs weeks.
- Ban `any` with ESLint (`@typescript-eslint/no-explicit-any`) and use `unknown` + narrowing instead.
- Run the type check in CI (`tsc -b` or `tsc --noEmit`): Vite itself won't fail a build on type errors.
- Don't fight inference: `const total = items.reduce(...)` usually needs no annotation.
:::

:::cards id=fe-03-cards1 xp=15 title="TypeScript essentials"
Q: Do TypeScript types exist at runtime?
A: No. They're erased. Runtime data (API, storage, forms) must still be validated.
Q: `interface` vs `type`?
A: Both describe objects. Only `type` can express unions/primitives/tuples; only `interface` merges declarations. Pick one convention.
Q: What is narrowing?
A: A runtime check (`typeof`, `in`, `instanceof`, `===`, truthiness) that lets TypeScript refine a union type inside the branch.
Q: `any` vs `unknown`?
A: `any` disables checking (and spreads). `unknown` accepts anything but forces you to narrow before use.
Q: `prop?: string` vs `prop: string | null`?
A: `?` = may be missing (undefined). `| null` = must be present but may be null.
Q: What does `x!` do?
A: Non-null assertion: tells the compiler x isn't null/undefined. No runtime check — a lie crashes.
Q: Why does `let m = 'GET'` not fit `'GET' | 'POST'`?
A: `let` widens to `string`. `const` keeps the literal type `"GET"`.
Q: What does `res.json()` / `JSON.parse` return in TypeScript?
A: `any` (`Promise<any>`). Annotate the result as `unknown` and validate — otherwise you're trusting the API blindly.
Q: What is structural typing?
A: A value fits a type if it has the required properties, regardless of declared names. Fresh object literals also get an excess-property check.
:::

## Recap

- TypeScript checks at compile time, then erases types — runtime data still needs validation.
- Let inference work; annotate parameters, return types of exported functions and public APIs.
- `interface` vs `type`: mostly equivalent for objects; only `type` does unions.
- Literal unions (`'idle' | 'loading'`) are the idiomatic enum.
- Narrow unions with `typeof`, `in`, `instanceof`, equality and truthiness.
- `strict` mode makes `null`/`undefined` explicit; prefer `?.`/`??` over `!`.
- Use `unknown`, not `any`, for anything from outside your code — and remember `JSON.parse`/`res.json()` return `any` until you say otherwise.
- `vite build` strips types without checking; `tsc` in CI is what catches type errors.
