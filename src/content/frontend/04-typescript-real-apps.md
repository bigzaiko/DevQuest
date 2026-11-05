---
id: fe-04
title: TypeScript for Real Apps
level: intermediate
minutes: 45
xp: 150
summary: Generics, utility types, discriminated unions with exhaustive checks, `satisfies`, `as const`, typing API responses and writing type guards.
---

The essentials let you annotate values. Real applications need more: one `fetchJson` helper that
works for users *and* orders, a state-transition function that can't forget an action, an API client
that admits the server might return garbage. This lesson stays in plain TypeScript (no React yet),
but every tool in it shows up in production TypeScript + React code bases — the React lessons from
**Components & JSX** onwards lean on all of it.

:::info
As before, the sandbox strips types and runs your code, so challenges test runtime behaviour.
Type-level knowledge is checked in the quizzes. Write the types anyway — it's the point of the
exercise, and your editor (not this sandbox) is where they pay off.
:::

## Generics: functions that keep the type

Without generics you choose between precision and reuse:

```ts
function firstString(list: string[]): string | undefined { return list[0] }   // precise, not reusable
function firstAny(list: any[]): any { return list[0] }                          // reusable, type lost
```

A **generic** has a *type parameter* — a placeholder filled in at each call site, usually inferred:

```ts
function first<T>(list: T[]): T | undefined {
  return list[0]
}

const n = first([1, 2, 3])         // T = number → n: number | undefined
const u = first([{ id: 1 }])       // T = { id: number }
const s = first<string>([])        // explicit: T = string (needed only when TS can't infer it)
```

Think of `T` as a function argument, but for types: the caller "passes" a type (usually without
noticing, through inference) and the function uses it to describe both its input and its output.
The return type says `T | undefined` on purpose — an empty array has no first element, and by
default TypeScript types `list[0]` as plain `T` (turn on `noUncheckedIndexedAccess` in
`tsconfig.json` if you want the compiler to add `| undefined` to every index access for you).

Inside the function body, TypeScript knows **nothing** about `T` — it could be `number`, `null`, or a
`Date`. So `list[0].id` would be an error. If your code needs something from `T`, say so with a
**constraint** (`extends`), which limits which types callers may pass:

```ts
function byId<T extends { id: number }>(items: T[], id: number): T | undefined {
  return items.find(i => i.id === id)      // OK: every T is guaranteed to have .id
}

function prop<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key]
}
prop({ name: 'Ada', age: 36 }, 'age')   // number
prop({ name: 'Ada' }, 'email')          // ❌ Argument of type '"email"' is not assignable to parameter of type '"name"'
```

`keyof T` is the union of `T`'s property names (`keyof { name: string; age: number }` is
`'name' | 'age'`), and `T[K]` is the type of that property (an *indexed access type*). Together
they're how libraries type things like `form.getValue('email')`: a typo in the key is a compile
error, and the return type follows the key you passed.

You've already used generics: `Array<string>`, `Promise<User>`, `Record<string, number>`,
`Map<string, User>`. You'll meet them again as soon as React starts — `useState<number>(0)` is
just a generic function call with `T = number`.

:::quiz id=fe-04-q4 xp=10
Spot the bug. What does TypeScript say about this function?

```ts
function longest<T>(items: T[]): T | undefined {
  let best: T | undefined
  for (const item of items) {
    if (best === undefined || item.length > best.length) best = item
  }
  return best
}
```

- [ ] Nothing — at the call `longest(['a', 'bb'])`, `T` is `string`, which has `.length`
- [x] Error: property `length` does not exist on type `T`; fix it with `<T extends { length: number }>`
- [ ] Nothing — an unconstrained `T` behaves like `any` inside the body
- [ ] Error only at call sites that pass something without `.length`, such as `longest([1, 2])`
> A generic body is checked **once**, for every possible `T`, not separately per call. With no
> constraint, `T` could be `number`, so `.length` isn't allowed. The tempting answer is the first one:
> it's true that this particular call passes strings, but the compiler doesn't type-check the body
> per call site. And an unconstrained `T` is closer to `unknown` than to `any` — you can pass it
> around, but you can't use its members. Adding `extends { length: number }` moves the error to
> where it belongs: `longest([1, 2])` is rejected at the call, and strings and arrays are accepted.
:::

:::challenge id=fe-04-c1 lang=ts xp=40
title: A generic groupBy
Write `groupBy<T, K extends string>(items: T[], keyOf: (item: T) => K): Record<K, T[]>`. It
returns an object mapping each key to the items with that key, in their original order.

hint: Start with `const out = {} as Record<K, T[]>` and loop.
hint: `(out[key] ??= []).push(item)`

```ts starter
export function groupBy<T, K extends string>(items: T[], keyOf: (item: T) => K): Record<K, T[]> {
  return {} as Record<K, T[]>
}
```

```ts solution
export function groupBy<T, K extends string>(items: T[], keyOf: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const item of items) {
    ;(out[keyOf(item)] ??= []).push(item)
  }
  return out
}
```

```ts tests
const tasks = [
  { id: 1, status: 'todo' },
  { id: 2, status: 'done' },
  { id: 3, status: 'todo' },
]
test('groups by key', () => {
  expect(groupBy(tasks, (t) => t.status)).toEqual({
    todo: [{ id: 1, status: 'todo' }, { id: 3, status: 'todo' }],
    done: [{ id: 2, status: 'done' }],
  })
})
test('keeps original item references', () => {
  expect(groupBy(tasks, (t) => t.status).done[0]).toBe(tasks[1])
})
test('works with computed keys', () => {
  const g = groupBy(['apple', 'avocado', 'banana'], (w) => w[0])
  expect(Object.keys(g)).toEqual(['a', 'b'])
  expect(g.a).toHaveLength(2)
})
test('empty list → empty object', () => {
  expect(groupBy([], (x) => String(x))).toEqual({})
})
```
:::

:::tip title="It's built in now"
Modern runtimes ship `Object.groupBy(items, keyOf)` (ES2024 — Node 21+, all current browsers; add
`"ES2024"` to `lib` in `tsconfig.json`). Its TypeScript return type is `Partial<Record<K, T[]>>` —
honest, because a key with no items is simply absent — and the object has a `null` prototype. Writing
your own version once is still the best way to understand how the generics flow.
:::

## Utility types: deriving types from types

Why derive? If `NewUser` is a hand-copied version of `User`, the day someone adds `phone` to `User`
the two silently drift apart. A derived type updates itself, and the compiler then points at every
place that needs the new field. TypeScript ships these **utility types** built in:

```ts
interface User {
  id: number
  name: string
  email: string
  role: 'admin' | 'member'
  createdAt: string
}

type UserPatch   = Partial<User>                  // every field optional — for PATCH bodies
type NewUser     = Omit<User, 'id' | 'createdAt'> // the server sets those
type UserPreview = Pick<User, 'id' | 'name'>      // just what a list row needs
type FullUser    = Required<UserPatch>            // every field required again
type Frozen      = Readonly<User>                 // all fields readonly
type ByRole      = Record<User['role'], User[]>   // { admin: User[]; member: User[] }

type Role = User['role']                          // 'admin' | 'member'
type Active = Exclude<Role | 'banned', 'banned'>  // 'admin' | 'member' — removes 'banned' from the union
type MaybeUser = User | null
type DefinitelyUser = NonNullable<MaybeUser>      // User

function createUser(input: NewUser) { /* … */ }
type Created = ReturnType<typeof createUser>      // the function's return type
type Args = Parameters<typeof createUser>         // [input: NewUser]
type Loaded = Awaited<Promise<User[]>>            // User[] — unwraps promises
```

`typeof` in a *type position* gets the type of a value. `ReturnType<typeof fn>` is how you type
things you don't own — e.g. `ReturnType<typeof setTimeout>` for a timer id that works in both Node
and the browser.

There's no magic inside them. Most are **mapped types** — a loop over the keys of another type —
written in a few lines of ordinary TypeScript:

```ts
type MyPartial<T>  = { [K in keyof T]?: T[K] }          // same keys, each optional
type MyReadonly<T> = { readonly [K in keyof T]: T[K] }
type MyPick<T, K extends keyof T> = { [P in K]: T[P] }   // only the listed keys
```

:::warn title="Common mistake: Omit doesn't check your keys"
`Pick<User, 'emial'>` is an error (the constraint is `K extends keyof T`), but
`Omit<User, 'emial'>` compiles happily and omits nothing — `Omit`'s key parameter accepts any
string. After renaming a field, re-check your `Omit`s.
:::

:::quiz id=fe-04-q1 xp=15
Given `interface Todo { id: number; title: string; done: boolean }`, which type describes the
body of a **create** request, where the server assigns `id` and `done` defaults to `false` but may be sent?

- [ ] `Partial<Todo>`
- [ ] `Pick<Todo, 'title'>`
- [x] `Omit<Todo, 'id' | 'done'> & Partial<Pick<Todo, 'done'>>`
- [ ] `Required<Todo>`
> `Omit` drops `id` (server-generated) and `done`, then `& Partial<Pick<Todo, 'done'>>` adds `done`
> back as optional — result: `{ title: string; done?: boolean }`.
> `Partial<Todo>` is the tempting one, but it makes `title` optional too (so `{}` would compile) and
> still lets the client send an `id`. `Pick<Todo, 'title'>` is close, but object literals with extra
> properties are rejected, so `{ title: 'x', done: true }` wouldn't compile. `Required<Todo>` demands
> the server-generated `id`.
:::

## Discriminated unions: modelling states

Here's a very common bug-magnet:

```ts
type RequestState = {
  loading: boolean
  data?: User[]
  error?: string
}
```

It allows nonsense like `{ loading: true, data: [...], error: 'x' }` — is that loading, done, or
failed? Every function that reads it (and later, every React component) has to guess, and the compiler can't help: `state.data` is
`User[] | undefined` everywhere, even right after a successful load.

Instead, model each **state** separately and give them a shared field whose type is a *literal*
(`'idle'`, `'loading'`…, not `string`) — the **discriminant**. A union of such object types is a
**discriminated union** (also called a *tagged union*):

```ts
type RequestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: User[] }
  | { status: 'error'; error: string }

function render(state: RequestState) {
  switch (state.status) {
    case 'idle':    return 'Press load'
    case 'loading': return 'Loading…'
    case 'success': return `${state.data.length} users`   // data exists only here
    case 'error':   return `Failed: ${state.error}`        // error exists only here
  }
}
```

Checking `state.status` **narrows** the whole object: inside `case 'success'` TypeScript knows
`state` is `{ status: 'success'; data: User[] }`, so `state.data` exists and isn't optional.
Outside that branch, `state.data` is a compile error. Impossible states become **unrepresentable**.
The same pattern types reducer actions, WebSocket messages, form steps, payment results…

Narrowing only works through the discriminant. A common mistake is destructuring first —
`const { status, data } = state` fails, because `data` doesn't exist on every member of the union.
Check `state.status`, then read the fields.

### Exhaustive checks with `never`

What happens when someone adds `{ status: 'cancelled' }` next month? Make the compiler find every
switch that needs updating:

```ts
function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`)
}

switch (state.status) {
  case 'idle': …
  case 'loading': …
  case 'success': …
  case 'error': …
  default:
    return assertNever(state)   // ❌ compile error if a case is missing: 'cancelled' is not assignable to never
}
```

`never` is the type with **no values** — the empty union. Each `case` removes one member from the
type of `state`, so after all four cases, what's left in `default` is `never`. Passing it to a
parameter of type `never` is fine. If a case is missing, the leftover member (say
`{ status: 'cancelled' }`) is still there, doesn't fit `never`, and you get a compile error pointing
at the exact switch. And at runtime, if bad data sneaks in anyway (an old API version, a cast), it
throws loudly instead of silently returning `undefined`.

:::challenge id=fe-04-c2 lang=ts xp=40
title: Shapes with an exhaustive switch
Implement `area(shape)` for the union below, with a `default` branch calling `assertNever`.
`assertNever` must throw an `Error` whose message contains `Unhandled`.

- circle: `π·r²`
- rect: `width·height`
- triangle: `base·height / 2`

hint: `switch (shape.kind) { case 'circle': return Math.PI * shape.radius ** 2 … }`
hint: `default: return assertNever(shape)`

```ts starter
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'triangle'; base: number; height: number }

export function assertNever(x: never): never {
  throw new Error('TODO')
}

export function area(shape: Shape): number {
  if (shape.kind === 'circle') return Math.PI * shape.radius ** 2
  return 0
}
```

```ts solution
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'rect'; width: number; height: number }
  | { kind: 'triangle'; base: number; height: number }

export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`)
}

export function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2
    case 'rect':
      return shape.width * shape.height
    case 'triangle':
      return (shape.base * shape.height) / 2
    default:
      return assertNever(shape)
  }
}
```

```ts tests
test('circle', () => {
  expect(area({ kind: 'circle', radius: 2 })).toBeCloseTo(12.566, 2)
})
test('rect', () => {
  expect(area({ kind: 'rect', width: 3, height: 4 })).toBe(12)
})
test('triangle', () => {
  expect(area({ kind: 'triangle', base: 6, height: 2 })).toBe(6)
})
test('unknown kinds throw instead of returning garbage', () => {
  expect(() => area({ kind: 'hexagon', side: 1 } as any)).toThrow('Unhandled')
})
```
:::

:::challenge id=fe-04-c3 lang=ts xp=50
title: A typed cart reducer
Reducers (you'll write them with `useReducer` later) take the current state and an **action**
(a discriminated union) and return the **next state without mutating**. Implement `cartReducer`:

- `add` — add `qty` of `productId`; if it's already in the cart, increase its `qty`
- `remove` — remove the line for `productId`
- `setQty` — set the qty of an existing line; a qty `<= 0` removes the line
- `clear` — empty cart
- anything else → throw (use `assertNever`, provided in setup)

"Without mutating" is checked: the tests make sure the original `state` and its `lines` array are
unchanged and that you return a **new** state object. That habit pays off in React: it compares
state by reference (`Object.is`), so a mutated-and-returned state looks "unchanged" and the UI
doesn't update.

```ts setup
function assertNever(x: never): never {
  throw new Error(`Unhandled action: ${JSON.stringify(x)}`)
}
type Line = { productId: number; qty: number }
type CartState = { lines: Line[] }
type CartAction =
  | { type: 'add'; productId: number; qty: number }
  | { type: 'remove'; productId: number }
  | { type: 'setQty'; productId: number; qty: number }
  | { type: 'clear' }
```

hint: For `add`: `state.lines.some(l => l.productId === action.productId)` decides between `map` and `[...lines, newLine]`.
hint: Return `{ ...state, lines: ... }` — always a new object.

```ts starter
export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add':
      state.lines.push({ productId: action.productId, qty: action.qty })
      return state
    default:
      return state
  }
}
```

```ts solution
export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const exists = state.lines.some((l) => l.productId === action.productId)
      const lines = exists
        ? state.lines.map((l) => (l.productId === action.productId ? { ...l, qty: l.qty + action.qty } : l))
        : [...state.lines, { productId: action.productId, qty: action.qty }]
      return { ...state, lines }
    }
    case 'remove':
      return { ...state, lines: state.lines.filter((l) => l.productId !== action.productId) }
    case 'setQty':
      return {
        ...state,
        lines: action.qty <= 0
          ? state.lines.filter((l) => l.productId !== action.productId)
          : state.lines.map((l) => (l.productId === action.productId ? { ...l, qty: action.qty } : l)),
      }
    case 'clear':
      return { ...state, lines: [] }
    default:
      return assertNever(action)
  }
}
```

```ts tests
const start = () => ({ lines: [{ productId: 1, qty: 2 }] })
test('add a new product', () => {
  const s = start()
  const next = cartReducer(s, { type: 'add', productId: 2, qty: 1 })
  expect(next.lines).toEqual([{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }])
  expect(s.lines).toHaveLength(1)
  expect(next).not.toBe(s)
})
test('add an existing product increases qty', () => {
  const s = start()
  const next = cartReducer(s, { type: 'add', productId: 1, qty: 3 })
  expect(next.lines).toEqual([{ productId: 1, qty: 5 }])
  expect(s).toEqual({ lines: [{ productId: 1, qty: 2 }] })
  expect(next).not.toBe(s)
})
test('remove', () => {
  const s = start()
  const next = cartReducer(s, { type: 'remove', productId: 1 })
  expect(next.lines).toEqual([])
  expect(s).toEqual({ lines: [{ productId: 1, qty: 2 }] })
  expect(next).not.toBe(s)
})
test('setQty and setQty 0', () => {
  const s = start()
  const next = cartReducer(s, { type: 'setQty', productId: 1, qty: 7 })
  expect(next.lines).toEqual([{ productId: 1, qty: 7 }])
  expect(s).toEqual({ lines: [{ productId: 1, qty: 2 }] })
  const s0 = start()
  expect(cartReducer(s0, { type: 'setQty', productId: 1, qty: 0 }).lines).toEqual([])
  expect(s0).toEqual({ lines: [{ productId: 1, qty: 2 }] })
})
test('clear', () => {
  expect(cartReducer(start(), { type: 'clear' }).lines).toEqual([])
})
test('unknown action throws', () => {
  expect(() => cartReducer(start(), { type: 'explode' } as any)).toThrow('Unhandled')
})
```
:::

## `as const` and `satisfies`

By default TypeScript **widens** literals in mutable places: `const xs = ['admin']` is `string[]`,
because you could push any string into it later. `as const` tells TypeScript "this won't change —
infer the narrowest, read-only type":

```ts
const ROLES = ['admin', 'editor', 'viewer'] as const
// type: readonly ['admin', 'editor', 'viewer']
type Role = (typeof ROLES)[number]          // 'admin' | 'editor' | 'viewer'

const routes = { home: '/', profile: '/me' } as const
// { readonly home: '/'; readonly profile: '/me' }
```

Now the list of roles is **one source of truth** for both runtime (render a `<select>`) and types.
`(typeof ROLES)[number]` reads as "the type you get by indexing the array with any number", i.e.
the union of its element types.

:::quiz id=fe-04-q5 xp=10
```ts
const ROLES = ['admin', 'editor']
type Role = (typeof ROLES)[number]
```

What is `Role`?

- [x] `string`
- [ ] `'admin' | 'editor'`
- [ ] `readonly ['admin', 'editor']`
- [ ] A compile error — you can't index a type with `number`
> Without `as const`, the array literal is widened to `string[]` (it's mutable, so TypeScript assumes
> any string may go in), and indexing `string[]` with `number` gives `string`. The tempting answer,
> `'admin' | 'editor'`, is what you get only after adding `as const`. Indexing an array type with
> `number` is perfectly legal — it's the standard way to get the element type.
:::

`satisfies` (TS 4.9+) checks a value *against* a type **without changing its inferred type**. The
problem it solves: an annotation like `const a: Theme = …` makes `a` *exactly* `Theme`, so anything
TypeScript knew about the concrete value (which keys exist, which literal values) is thrown away.

```ts
type Theme = Record<string, `#${string}`>

const a: Theme = { primary: '#3366ff', danger: '#ff3355' }
a.primary      // type `#${string}` — fine
a.secondary    // no error! Record<string, …> allows any key — we lost the real keys

const b = { primary: '#3366ff', danger: '#ff3355' } satisfies Theme
b.primary      // ✅ typed, and the object was checked against Theme
b.secondary    // ❌ Property 'secondary' does not exist — keys are preserved
const c = { primary: 'blue' } satisfies Theme   // ❌ '"blue"' doesn't match `#${string}`
```

Rule of thumb: **annotate** (`: Type`) when you want the variable to *be* that type; use
**`satisfies`** when you want validation but keep the precise inferred type — config objects,
route tables, lookup maps. `as const satisfies T` combines both.

:::quiz id=fe-04-q2 xp=15
```ts
const STATUS_LABEL = {
  todo: 'To do',
  doing: 'In progress',
  done: 'Done',
} satisfies Record<'todo' | 'doing' | 'done', string>
```

What happens if a teammate removes the `done` line?

- [x] Compile error: property `done` is missing
- [ ] Nothing, `satisfies` is only a hint
- [ ] Runtime error when `STATUS_LABEL.done` is read
> `satisfies` is a real compile-time check, not a hint: `Record<'todo' | 'doing' | 'done', string>`
> requires all three keys, so removing one fails the build. It can't be a *runtime* error — types are
> erased before the code runs, and reading a missing key would just give `undefined`. Compare with
> `{ … } as Record<…>`: a cast tells the compiler "trust me" and would silence the missing key —
> which is why casts are a code-review smell.
:::

## Typing API responses honestly

This is the most common lie in frontend TypeScript:

```ts
const user = (await res.json()) as User   // "trust me"
```

`res.json()` returns `Promise<any>`. The cast compiles, but if the backend renames `name` to
`fullName`, nothing tells you — the bug shows up as `undefined` on screen. TypeScript types are
erased at build time, so they can't check data that arrives at runtime; *something* has to look at
the actual JSON.

The honest starting type for outside data is **`unknown`**: like `any` it accepts every value, but
unlike `any` it lets you do *nothing* with it until you've checked what it is. Options, from weakest
to strongest:

1. **Cast** (`as User`) — fine for prototypes and when you generate types from the backend (OpenAPI → TS with `openapi-typescript`, or NSwag from ASP.NET).
2. **Type guards** — hand-written runtime checks that narrow `unknown` to `User`.
3. **Schema validation** — libraries like **Zod** or **Valibot** define the schema once and give you both the runtime validator and the static type (`z.infer<typeof UserSchema>`).

A **type guard** is a function returning a *type predicate* `x is T`:

```ts
function isUser(x: unknown): x is User {
  return (
    typeof x === 'object' && x !== null &&
    'id' in x && typeof x.id === 'number' &&
    'name' in x && typeof x.name === 'string'
  )
}

const data: unknown = await res.json()
if (!isUser(data)) throw new Error('Unexpected response shape')
data.name   // data: User here
```

`'id' in x` narrows `x` to "an object that has an `id`" (TS 4.9+), which is what makes
`typeof x.id` legal on an `unknown` value. The return type `x is User` is the contract: when the
function returns `true`, callers may treat `x` as a `User`.

With a schema library you describe the shape once and get both the check and the type:

```ts
import { z } from 'zod'

const UserSchema = z.object({ id: z.number(), name: z.string(), email: z.email() })
type User = z.infer<typeof UserSchema>          // { id: number; name: string; email: string }

const user = UserSchema.parse(await res.json()) // throws a detailed ZodError if the shape is wrong
// or: const r = UserSchema.safeParse(json); if (!r.success) … else r.data
```

For results that can fail, a discriminated `Result` type makes callers handle both paths:

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const r = parseUsers(json)
if (r.ok) show(r.data)      // narrowed: data exists
else showError(r.error)     // narrowed: error exists
```

:::challenge id=fe-04-c4 lang=ts xp=50
title: Validate a user list response
Write `isUser(x: unknown): x is User` and `parseUsers(json: unknown): Result<User[]>`.

A valid `User` is an object with `id` (number), `name` (string) and `email` (string, must contain `@`).
`role` is optional but, if present, must be `'admin'` or `'member'`.

`parseUsers` expects `{ items: [...] }`. It returns `{ ok: true, data }` if `items` is an array of
valid users, otherwise `{ ok: false, error }` where `error` is `'Expected { items: [] }'` if
the outer shape is wrong, or `'Invalid user at index <i>'` for the first bad item.

```ts setup
type User = { id: number; name: string; email: string; role?: 'admin' | 'member' }
type Result<T> = { ok: true; data: T } | { ok: false; error: string }
```

hint: `typeof x === 'object' && x !== null` first, then check each field with `'id' in x && typeof x.id === 'number'`.
hint: `findIndex(u => !isUser(u))` gives the first bad index (or -1).

```ts starter
export function isUser(x: unknown): x is User {
  return typeof x === 'object'
}

export function parseUsers(json: unknown): Result<User[]> {
  return { ok: true, data: (json as any).items }
}
```

```ts solution
export function isUser(x: unknown): x is User {
  if (typeof x !== 'object' || x === null) return false
  const u = x as Record<string, unknown>
  if (typeof u.id !== 'number') return false
  if (typeof u.name !== 'string') return false
  if (typeof u.email !== 'string' || !u.email.includes('@')) return false
  if (u.role !== undefined && u.role !== 'admin' && u.role !== 'member') return false
  return true
}

export function parseUsers(json: unknown): Result<User[]> {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { items?: unknown }).items)) {
    return { ok: false, error: 'Expected { items: [] }' }
  }
  const items = (json as { items: unknown[] }).items
  const bad = items.findIndex((u) => !isUser(u))
  if (bad !== -1) return { ok: false, error: `Invalid user at index ${bad}` }
  return { ok: true, data: items as User[] }
}
```

```ts tests
const ada = { id: 1, name: 'Ada', email: 'ada@example.com' }
test('accepts valid users', () => {
  expect(isUser(ada)).toBe(true)
  expect(isUser({ ...ada, role: 'admin' })).toBe(true)
})
test('rejects wrong shapes', () => {
  expect(isUser(null)).toBe(false)
  expect(isUser('ada')).toBe(false)
  expect(isUser({ ...ada, id: '1' })).toBe(false)
  expect(isUser({ id: 1, name: 'Ada' })).toBe(false)
  expect(isUser({ ...ada, email: 'nope' })).toBe(false)
  expect(isUser({ ...ada, role: 'root' })).toBe(false)
})
test('parseUsers ok', () => {
  expect(parseUsers({ items: [ada] })).toEqual({ ok: true, data: [ada] })
  expect(parseUsers({ items: [] })).toEqual({ ok: true, data: [] })
})
test('parseUsers outer shape', () => {
  expect(parseUsers([ada])).toEqual({ ok: false, error: 'Expected { items: [] }' })
  expect(parseUsers(null)).toEqual({ ok: false, error: 'Expected { items: [] }' })
})
test('parseUsers reports the first bad index', () => {
  expect(parseUsers({ items: [ada, ada, { id: 3 }, {}] })).toEqual({ ok: false, error: 'Invalid user at index 2' })
})
```
:::

:::quiz id=fe-04-q6 xp=10
A teammate writes this guard. What does the TypeScript compiler do?

```ts
type Admin = { id: number; permissions: string[] }

function isAdmin(x: unknown): x is Admin {
  return typeof x === 'object' && x !== null && 'id' in x
}
```

- [x] Accepts it — the compiler trusts a type predicate and doesn't verify that the body proves it
- [ ] Reports an error because the body never checks `permissions`
- [ ] Accepts it, but inserts the missing `permissions` check into the compiled JavaScript
> A type predicate is a promise *you* make. TypeScript only checks that the function returns a
> boolean; it can't prove the body establishes `x is Admin`. Here, `{ id: 'x' }` would be "an admin",
> and code reading `x.permissions.includes(…)` crashes. The compiler never adds runtime checks —
> TypeScript emits your JavaScript with the types removed. (TS 5.5+ can *infer* predicates for simple
> functions like `(x) => x !== null`, but an explicit `x is T` is always taken on trust.) That's
> why guards deserve tests — next challenge.
:::

:::challenge id=fe-04-c5 lang=ts mode=tests xp=60
title: Test a type guard
Type guards are runtime code — and a buggy one is worse than none, because the compiler *trusts* it.
Here is `isProduct(x): x is Product` where `Product = { sku: string; price: number; tags: string[] }`
(`price` must be a finite number ≥ 0). Write tests that pass for the real guard and catch the three
hidden broken versions.

```ts setup
type Product = { sku: string; price: number; tags: string[] }
```

hint: Think about `null` (remember `typeof null === 'object'`).
hint: Think about a negative or `NaN` price.
hint: Think about `tags` not being an array, or containing non-strings.

```ts impl
export function isProduct(x: unknown): x is Product {
  if (typeof x !== 'object' || x === null) return false
  const p = x as Record<string, unknown>
  return (
    typeof p.sku === 'string' &&
    typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0 &&
    Array.isArray(p.tags) && p.tags.every((t) => typeof t === 'string')
  )
}
```

```ts mutant
export function isProduct(x: unknown): x is Product {
  if (typeof x !== 'object') return false
  const p = x as Record<string, unknown>
  return (
    typeof p.sku === 'string' &&
    typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0 &&
    Array.isArray(p.tags) && p.tags.every((t) => typeof t === 'string')
  )
}
```

```ts mutant
export function isProduct(x: unknown): x is Product {
  if (typeof x !== 'object' || x === null) return false
  const p = x as Record<string, unknown>
  return (
    typeof p.sku === 'string' &&
    typeof p.price === 'number' &&
    Array.isArray(p.tags) && p.tags.every((t) => typeof t === 'string')
  )
}
```

```ts mutant
export function isProduct(x: unknown): x is Product {
  if (typeof x !== 'object' || x === null) return false
  const p = x as Record<string, unknown>
  return (
    typeof p.sku === 'string' &&
    typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0 &&
    Array.isArray(p.tags)
  )
}
```

```ts starter
test('accepts a valid product', () => {
  expect(isProduct({ sku: 'A1', price: 10, tags: ['new'] })).toBe(true)
})
```

```ts solution
const good = { sku: 'A1', price: 10, tags: ['new'] }
test('accepts a valid product', () => {
  expect(isProduct(good)).toBe(true)
  expect(isProduct({ ...good, price: 0, tags: [] })).toBe(true)
})
test('rejects null and primitives', () => {
  expect(isProduct(null)).toBe(false)
  expect(isProduct('A1')).toBe(false)
})
test('rejects bad prices', () => {
  expect(isProduct({ ...good, price: -1 })).toBe(false)
  expect(isProduct({ ...good, price: NaN })).toBe(false)
})
test('rejects bad tags', () => {
  expect(isProduct({ ...good, tags: 'new' })).toBe(false)
  expect(isProduct({ ...good, tags: [1, 2] })).toBe(false)
})
```
:::

:::quiz id=fe-04-q3 xp=10
Which statements about `as` casts are true? (select all that apply)

- [x] `data as User` performs no runtime check
- [ ] `data as User` throws if `data` is not a `User`
- [x] Generated types (e.g. from an OpenAPI spec) make casts at the API boundary much safer
- [x] A type guard or schema validator (Zod/Valibot) checks the data at runtime
> Casts are compile-time only: `as` emits no JavaScript at all, so it can't throw — the wrong data
> flows on and fails later, somewhere else. Casts are acceptable when the type source is trustworthy
> (types generated from the backend's contract and regenerated when it changes), but only a runtime
> check — a type guard or a schema validator — catches a backend change at the boundary, before it
> becomes `undefined` in the UI.
:::

:::job title="Where you'll meet this on day one"
- An `api/` folder with a typed client — often generated from the backend's OpenAPI document
  (ASP.NET Core 10 produces one with `Microsoft.AspNetCore.OpenApi`).
- `type Props = { … }` for every component, plus generics on reusable ones (`<Select<T>>`, `<Table<Row>>`).
- Discriminated unions for request state, reducer actions and WebSocket messages, with `assertNever` in the `default`.
- A Zod schema next to each form, used for both validation and the form's TypeScript type.
:::

:::pro title="Generics: don't overdo it"
If a type parameter is used only once, you probably don't need it — `function log<T>(x: T): void`
is just `function log(x: unknown): void`. Good generics *connect* types: input to output, key to
value, item to callback. Also prefer letting callers' types be inferred over making them write
`fn<Foo, Bar>(…)`.
:::

:::cards id=fe-04-cards1 xp=15 title="TypeScript for real apps"
Q: What is a generic type parameter?
A: A placeholder type filled in per use (usually inferred), connecting input and output types: `first<T>(xs: T[]): T | undefined`.
Q: `keyof T` and `T[K]`?
A: `keyof T` = union of T's keys; `T[K]` = type of property K. Used for `prop(obj, key)`.
Q: Partial / Pick / Omit / Record?
A: All optional / keep some keys / drop some keys / object type with given keys and value type.
Q: `ReturnType<typeof fn>`?
A: The return type of function `fn`. `typeof` in a type position takes a value's type.
Q: What is a discriminated union?
A: A union of object types sharing a literal field (e.g. `status`) — checking it narrows the whole object.
Q: Why `assertNever(x: never)` in `default`?
A: Compile error if a union member isn't handled; runtime throw if bad data sneaks in.
Q: `satisfies` vs annotation?
A: Annotation makes the variable that type (loses detail). `satisfies` checks against the type but keeps the precise inferred type.
Q: `as const`?
A: Infer the narrowest read-only literal types: `['a','b'] as const` → `readonly ['a','b']`.
Q: What does a type guard return?
A: A type predicate `x is T` — a boolean that, when true, narrows `x` to `T` for the compiler.
Q: `unknown` vs `any`?
A: Both accept any value. `any` switches checking off; `unknown` forces you to narrow (typeof, `in`, a guard) before using it — the right type for API data.
Q: What is `never`?
A: The type with no values. After every union member is handled, the leftover is `never` — the basis of exhaustive checks.
:::

## Recap

- Generics connect types across inputs and outputs; constrain them with `extends` and `keyof`.
- Derive types with `Partial`, `Pick`, `Omit`, `Record`, `ReturnType`, `Awaited` instead of copying.
- Model states and actions as discriminated unions; finish switches with `assertNever`.
- `as const` freezes literals into types; `satisfies` validates without widening.
- `res.json()` is `any` in disguise: start from `unknown`, then use generated types, type guards or a schema validator (Zod/Valibot) at the boundary.
- Type guards are runtime code the compiler trusts blindly — test them.
