---
id: fe-01
title: Modern JavaScript Refresher
level: beginner
minutes: 55
xp: 100
summary: let/const, arrow functions, destructuring, spread, optional chaining, modules and the array methods every React codebase lives on.
---

React, TypeScript and Vite are all "just JavaScript" underneath. Most bugs juniors hit in React code
are not React bugs at all — they are JavaScript bugs: a mutated array, a `||` that swallowed a `0`,
an object compared by reference. This lesson refreshes the parts of modern JavaScript (ES2015 →
ES2024) you will type every single day, and explains *why* they behave the way they do.

## `let`, `const` and why `var` is gone

A **binding** is the link between a variable name and a value. The question each keyword answers
is: *where is this name visible* (its **scope**), and *can it be pointed at a different value later*?

```js
const max = 10      // cannot be reassigned
let count = 0       // can be reassigned
count = count + 1

if (true) {
  let inside = 'block scoped'
}
// console.log(inside) → ReferenceError: inside is not defined
```

`let` and `const` are **block scoped**: they live inside the nearest `{ }` (an `if`, a loop body,
a function). The old `var` is *function* scoped and *hoisted*: the declaration is treated as if it
were written at the top of the function and initialised as `undefined`. That produced the most
famous JavaScript bug of all — every callback in a loop sharing the same variable:

```js
for (var i = 0; i < 3; i++) setTimeout(() => console.log(i))   // 3, 3, 3 — one shared i
for (let j = 0; j < 3; j++) setTimeout(() => console.log(j))   // 0, 1, 2 — a fresh j per iteration
```

`let`/`const` are hoisted too, but they sit in the **temporal dead zone** until their line runs:
reading them earlier throws a `ReferenceError` instead of silently giving `undefined`. A loud
error is better than a quiet wrong value.

The rule real teams follow: **`const` by default, `let` when you truly reassign, never `var`.**
Seeing `let` then tells the reader "watch out, this changes". Linters (ESLint `prefer-const`,
`no-var`) enforce it.

:::warn title="const is not immutable"
`const` freezes the **binding** (the variable name → value link), not the value. A `const` array
can still be pushed to, a `const` object can still be changed:

```js
const user = { name: 'Ada' }
user.name = 'Grace'   // allowed!
user = {}             // TypeError: Assignment to constant variable.
```
:::

:::quiz id=fe-01-q1 xp=10
What does this log?

```js
const settings = { theme: 'light' }
settings.theme = 'dark'
console.log(settings.theme)
```

- [ ] `"light"` — `const` objects cannot change
- [x] `"dark"`
- [ ] It throws a `TypeError`
> `const` only prevents re-binding `settings` to a different object (`settings = {}` would throw).
> Changing a property is not re-binding, so no `TypeError`; the object itself is still mutable. Use `Object.freeze` (shallow!) or — much more common — simply *don't mutate*, as we'll
> see in the immutability section.
:::

## Arrow functions

```js
function add(a, b) { return a + b }   // declaration
const add2 = (a, b) => a + b          // arrow, implicit return
const square = x => x * x             // one param: parens optional
const makeUser = name => ({ name })   // returning an object literal: wrap in ( )
const log = () => {                   // block body: needs explicit return
  console.log('hi')
}
```

Arrow functions are shorter, but the real difference is **`this`**. A normal `function` gets its
`this` from *how it is called* (`obj.method()` → `obj`; a bare call → `undefined` in strict mode).
An arrow function has no `this` of its own — it uses the `this` of the code around it, decided
where it is *written*:

```js
class Timer {
  seconds = 0
  start() {
    setInterval(function () { this.seconds++ }, 1000) // ❌ `this` is not the Timer here
    setInterval(() => { this.seconds++ }, 1000)       // ✅ arrow uses start()'s `this`
  }
}
```

That fixed the infamous "`this` is undefined in my callback" bug of class-based code. Arrows also
have no `arguments` of their own (like `this`, they see the surrounding function's; use rest
parameters `(...args)` instead) and can't be called with `new`. In React function components you almost
never use `this` at all, so arrows are simply the idiomatic way to write callbacks:

```js
const names = users.map(u => u.name)
button.addEventListener('click', () => setOpen(true))
```

:::tip
Forgetting the parentheses around an object literal is a classic: `x => { id: x }` is a function
with a *block* containing a label `id:` and returns `undefined`. Write `x => ({ id: x })`.
:::

## Template literals

Gluing strings with `+` gets unreadable fast and is easy to get wrong (`'Total: ' + 1 + 2` is
`'Total: 12'`). Backtick strings let you drop any expression into `${ }` and may span lines:

```js
const name = 'Ada'
const msg = `Hello, ${name}! You have ${3 + 4} new messages.`
const multi = `line one
line two`
const cls = `btn ${isActive ? 'btn-active' : ''}`   // common in JSX className logic
```

:::warn title="Never build SQL or HTML from user input with template literals"
`` `SELECT * FROM users WHERE name = '${name}'` `` is an SQL injection, and
`` el.innerHTML = `<b>${comment}</b>` `` is an XSS hole. Use parameterised queries on the backend
and let React escape text for you (`<b>{comment}</b>`).
:::

## Destructuring

Destructuring pulls values out of objects and arrays into variables. You will see it on *every*
React component (`function Card({ title, children })`) and every hook (`const [count, setCount] = useState(0)`).

```js
const user = { id: 7, name: 'Ada', address: { city: 'London' } }

const { name, id } = user                    // name = 'Ada', id = 7
const { name: fullName } = user              // rename: fullName = 'Ada'
const { role = 'guest' } = user              // default when undefined: 'guest'
const { address: { city } } = user           // nested: city = 'London'

const [first, second, ...others] = [10, 20, 30, 40]  // 10, 20, [30, 40]
const [, , third] = [1, 2, 3]                // skip items: 3

function greet({ name, greeting = 'Hello' }) {      // in parameters
  return `${greeting}, ${name}`
}
```

Defaults apply only when the value is `undefined` — **not** when it is `null`, `0` or `''`:

```js
const { limit = 10 } = { limit: null }   // limit = null  (not 10!)
const { limit2 = 10 } = {}               // limit2 = 10
```

APIs that send `null` for "no value" will therefore *bypass* your destructuring defaults — use
`?? fallback` when `null` is possible. And destructuring a missing object throws:
`const { a } = undefined` → `TypeError`. Give the parameter a default (`function f({ a } = {})`)
when the whole argument may be absent.

## Spread and rest

The same `...` syntax means two opposite things depending on where it is:

- **Spread** (in an expression) *expands* an array/object into its parts.
- **Rest** (in a pattern or parameter list) *collects* the remaining parts.

```js
// spread
const a = [1, 2]
const b = [...a, 3]                       // [1, 2, 3]
const base = { theme: 'light', lang: 'en' }
const prefs = { ...base, theme: 'dark' }  // later keys win → { theme: 'dark', lang: 'en' }
Math.max(...[4, 9, 2])                    // 9

// rest
function sum(...nums) { return nums.reduce((s, n) => s + n, 0) }
const { password, ...publicUser } = { name: 'Ada', password: 'x' }  // publicUser = { name: 'Ada' }
```

:::warn title="Spread is shallow"
`{ ...obj }` copies the top level only. Nested objects are still **shared**:

```js
const original = { name: 'Ada', address: { city: 'London' } }
const copy = { ...original }
copy.address.city = 'Paris'
console.log(original.address.city) // 'Paris' — same nested object!
```

To change a nested value immutably, spread each level you touch:
`{ ...original, address: { ...original.address, city: 'Paris' } }`. For a true deep clone use
`structuredClone(obj)`.
:::

:::quiz id=fe-01-q2 xp=10
What does this log?

```js
const a = { tags: ['js'], level: 1 }
const b = { ...a, level: 2 }
b.tags.push('react')
console.log(a.level, a.tags.length)
```

- [ ] `2 2`
- [ ] `1 1`
- [x] `1 2`
- [ ] `2 1`
> `level` is a primitive copied into `b` and then overwritten, so `a.level` stays `1`. But `tags`
> is an array — the spread copied the *reference*, so `a.tags` and `b.tags` are the same array.
> `1 1` is the tempting answer if you assume spread makes a deep copy; it doesn't.
:::

## Optional chaining `?.` and nullish coalescing `??`

API data is full of "maybe missing" values. These two operators handle them without a pyramid of
`if`s:

```js
const city = user?.address?.city        // undefined instead of a crash if user or address is missing
const first = list?.[0]                 // optional index access
onChange?.(value)                       // call only if the function exists

const pageSize = settings.pageSize ?? 20   // 20 only if pageSize is null or undefined
```

The difference between `??` and `||` matters a lot:

| Expression | `value = 0` | `value = ''` | `value = null` |
|---|---|---|---|
| `value \|\| 10` | `10` 😬 | `10` 😬 | `10` |
| `value ?? 10` | `0` | `''` | `10` |

`||` falls back on any **falsy** value (`0`, `''`, `false`, `NaN`, `null`, `undefined`).
`??` falls back only on **nullish** values (`null`, `undefined`). If `0` items or an empty string
is a *valid* value — and it usually is — use `??`.

:::challenge id=fe-01-c1 lang=js xp=30
title: Safe profile access
API users may be missing `profile`, `profile.address` or `settings`. Write `describeUser(user)`
that returns an object with:

- `city`: `user.profile.address.city`, or `'Unknown'` if anything on the way is missing
- `pageSize`: `user.settings.pageSize`, or `20` if it is `null`/`undefined` — **but keep `0`**
- `nickname`: `user.profile.nickname`, or `'Anonymous'` if missing — **but keep an empty string `''`**

hint: `user.profile?.address?.city ?? 'Unknown'`
hint: `||` would replace `0` and `''` — use `??` everywhere.

```js starter
export function describeUser(user) {
  return {
    city: user.profile.address.city || 'Unknown',
    pageSize: user.settings.pageSize || 20,
    nickname: user.profile.nickname || 'Anonymous',
  }
}
```

```js solution
export function describeUser(user) {
  return {
    city: user?.profile?.address?.city ?? 'Unknown',
    pageSize: user?.settings?.pageSize ?? 20,
    nickname: user?.profile?.nickname ?? 'Anonymous',
  }
}
```

```js tests
test('full user', () => {
  const u = { profile: { nickname: 'ada', address: { city: 'London' } }, settings: { pageSize: 50 } }
  expect(describeUser(u)).toEqual({ city: 'London', pageSize: 50, nickname: 'ada' })
})
test('empty object does not crash', () => {
  expect(describeUser({})).toEqual({ city: 'Unknown', pageSize: 20, nickname: 'Anonymous' })
})
test('profile without address', () => {
  expect(describeUser({ profile: { nickname: 'x' } }).city).toBe('Unknown')
})
test('keeps a pageSize of 0', () => {
  expect(describeUser({ settings: { pageSize: 0 } }).pageSize).toBe(0)
})
test('keeps an empty nickname', () => {
  expect(describeUser({ profile: { nickname: '' } }).nickname).toBe('')
})
test('null pageSize falls back', () => {
  expect(describeUser({ settings: { pageSize: null } }).pageSize).toBe(20)
})
```
:::

## Modules: `import` and `export`

Every file in a Vite/React project is an **ES module**. A module has its own scope; only what you
`export` is visible to others.

```js
// math.js
export const PI = 3.14159              // named export
export function area(r) { return PI * r * r }
export default function circle() {}   // one default export per file (optional)

// app.js
import circle, { area, PI as pi } from './math.js'   // default + named (+ rename)
import * as math from './math.js'                    // namespace import
const { heavy } = await import('./heavy.js')         // dynamic import → code splitting
```

Things worth knowing:

- Static `import`/`export` must be at the top level with a literal path, so tools can read the whole
  dependency graph **without running the code**. That's what lets Vite (and Rolldown, its bundler)
  do *tree shaking*: dropping exports nobody imports from the production bundle.
- Imports are **live, read-only bindings**: you see the exporter's current value, but you can't
  assign to an imported name (`PI = 3` → `TypeError`).
- Modules run **once**, no matter how many files import them; they are singletons. A `const cache = new Map()`
  at the top of a module is shared by everyone who imports it.
- Modules are always in strict mode.
- `import()` (dynamic import) returns a promise and tells Vite to split that file into its own
  chunk, loaded on demand. React's `lazy()` is built on it.

:::job title="Named vs default exports at work"
Many teams ban default exports in app code (ESLint `import/no-default-export`). Named exports
mean the same thing has the same name everywhere, rename-refactors work across the codebase,
and auto-import in the editor picks the right symbol. Expect to follow whatever the repo already does —
and to see `export function Button()` rather than `export default`.
:::

## Array methods: the daily toolbox

React renders lists with `map`, filters them with `filter`, and computes totals with `reduce`.
These methods **don't mutate** the original array — they return something new, which is exactly
what React wants.

```js
const orders = [
  { id: 1, customer: 'Ada', total: 30, status: 'paid' },
  { id: 2, customer: 'Linus', total: 12, status: 'open' },
  { id: 3, customer: 'Ada', total: 55, status: 'paid' },
]

orders.map(o => o.total)                         // [30, 12, 55]       transform each
orders.filter(o => o.status === 'paid')          // [order 1, order 3] keep some
orders.find(o => o.id === 2)                     // order 2 (or undefined)
orders.findIndex(o => o.id === 2)                // 1 (or -1)
orders.some(o => o.total > 50)                   // true   — at least one
orders.every(o => o.total > 10)                  // true   — all of them
orders.reduce((sum, o) => sum + o.total, 0)      // 97     — fold into one value
orders.flatMap(o => [o.id, o.id * 10])           // [1, 10, 2, 20, 3, 30] — map then flatten one level
orders.map(o => o.customer).includes('Linus')    // true
```

`reduce` deserves a closer look because it is the most general one: it walks the array carrying
an **accumulator**. The second argument is the *initial* accumulator — always pass it, otherwise
`reduce` on an empty array throws.

```js
// group orders by customer → { Ada: [..], Linus: [..] }
const byCustomer = orders.reduce((acc, o) => {
  (acc[o.customer] ??= []).push(o)
  return acc
}, {})

// modern alternative (ES2024): Object.groupBy(orders, o => o.customer)
```

Read it like this: start with `{}`; for each order, make sure `acc[customer]` is an array
(`??=` assigns only if it is still `null`/`undefined`), push the order, and **return the
accumulator** for the next round. Forgetting `return acc` is the #1 `reduce` bug — the next
iteration then receives `undefined`.

:::quiz id=fe-01-q3 xp=10
Which statements are true? (select all that apply)

- [x] `[].every(x => x > 100)` is `true`
- [ ] `[].some(x => x > 100)` is `true`
- [x] `[1, 2, 3].find(x => x > 5)` is `undefined`
- [ ] `[1, 2, 3].filter(x => x > 5)` is `undefined`
- [x] `[[1], [2, 3]].flatMap(x => x)` is `[1, 2, 3]`
> `every` on an empty array is *vacuously true* (no element breaks the rule) — a classic source of
> "why is the Submit button enabled with zero items?" bugs. `some` on empty is `false`. `find`
> returns `undefined` when nothing matches, while `filter` always returns an array (maybe empty)
> — here `[]`. `flatMap(x => x)` maps each item to itself (an array) and flattens one level,
> giving `[1, 2, 3]`.
:::

:::challenge id=fe-01-c2 lang=js xp=40
title: Order report
Write `orderReport(orders)` that returns `{ count, revenue, topCustomer }` for **paid** orders only:

- `count`: number of paid orders
- `revenue`: sum of their `total`
- `topCustomer`: the customer with the highest *summed* paid total (add up all of a customer's paid
  orders first), or `null` if there are no paid orders

Don't mutate the input (no `sort`, `push` or property assignment on the array or its orders).

hint: Start with `const paid = orders.filter(o => o.status === 'paid')`.
hint: Build `{ customer: sum }` with `reduce`, then pick the max with `Object.entries(...)`.

```js starter
export function orderReport(orders) {
  return { count: 0, revenue: 0, topCustomer: null }
}
```

```js solution
export function orderReport(orders) {
  const paid = orders.filter(o => o.status === 'paid')
  const revenue = paid.reduce((sum, o) => sum + o.total, 0)
  const perCustomer = paid.reduce((acc, o) => {
    acc[o.customer] = (acc[o.customer] ?? 0) + o.total
    return acc
  }, {})
  let topCustomer = null
  let best = -Infinity
  for (const [name, sum] of Object.entries(perCustomer)) {
    if (sum > best) { best = sum; topCustomer = name }
  }
  return { count: paid.length, revenue, topCustomer }
}
```

```js tests
const sample = [
  { id: 1, customer: 'Ada', total: 30, status: 'paid' },
  { id: 2, customer: 'Linus', total: 70, status: 'open' },
  { id: 3, customer: 'Grace', total: 40, status: 'paid' },
  { id: 4, customer: 'Ada', total: 25, status: 'paid' },
]
test('counts only paid orders', () => {
  expect(orderReport(sample).count).toBe(3)
})
test('sums paid revenue', () => {
  expect(orderReport(sample).revenue).toBe(95)
})
test('top customer uses the summed total', () => {
  expect(orderReport(sample).topCustomer).toBe('Ada')
})
test('no paid orders', () => {
  expect(orderReport([{ id: 9, customer: 'X', total: 5, status: 'open' }])).toEqual({ count: 0, revenue: 0, topCustomer: null })
})
test('does not mutate input', () => {
  const copy = JSON.parse(JSON.stringify(sample))
  orderReport(sample)
  expect(sample).toEqual(copy)
})
```
:::

## Immutability: why React cares

React decides whether something changed by comparing **references** (`Object.is(prev, next)`),
not by deep-comparing contents. Compare:

```js
const todos = [{ id: 1, done: false }]

// ❌ mutation — same array, same object. React sees "nothing changed".
todos[0].done = true
setTodos(todos)

// ✅ new array, new object for the changed item, other items reused as-is
setTodos(todos.map(t => (t.id === 1 ? { ...t, done: true } : t)))
```

Reference comparison is cheap (one pointer check) no matter how big the data is; that's the whole
reason the ecosystem leans on immutable updates. The cheat sheet:

| Instead of (mutating) | Use (returns a new value) |
|---|---|
| `arr.push(x)` | `[...arr, x]` |
| `arr.unshift(x)` | `[x, ...arr]` |
| `arr.splice(i, 1)` | `arr.filter((_, j) => j !== i)` or `arr.toSpliced(i, 1)` |
| `arr[i] = x` | `arr.map((v, j) => (j === i ? x : v))` or `arr.with(i, x)` |
| `arr.sort()` | `[...arr].sort()` or `arr.toSorted()` |
| `arr.reverse()` | `arr.toReversed()` |
| `obj.key = v` | `{ ...obj, key: v }` |
| `delete obj.key` | `const { key, ...rest } = obj` |

`toSorted`, `toReversed`, `toSpliced` and `with` (ES2023) are the non-mutating twins of the old
methods — supported in every evergreen browser.

:::warn title="sort() mutates and sorts as strings"
`[10, 9, 1].sort()` gives `[1, 10, 9]` — the default comparison converts to strings. Always pass
a comparator for numbers, `(a, b) => a - b`, and use `toSorted` so you don't reorder the array
someone else is still holding (like React state).
:::

:::challenge id=fe-01-c3 lang=js xp=40
title: Immutable todo updates
Implement three helpers that **never mutate** their input:

- `addTodo(todos, text)` → appends `{ id, text, done: false }` where `id` is `max existing id + 1` (or `1` for an empty list)
- `toggleTodo(todos, id)` → flips `done` for that id
- `removeTodo(todos, id)` → drops that id

Unchanged todos must keep the **same object reference** (React relies on that to skip work).

hint: `Math.max(0, ...todos.map(t => t.id)) + 1`
hint: `todos.map(t => (t.id === id ? { ...t, done: !t.done } : t))`

```js starter
export function addTodo(todos, text) {
  todos.push({ id: todos.length + 1, text, done: false })
  return todos
}
export function toggleTodo(todos, id) {
  const t = todos.find(t => t.id === id)
  t.done = !t.done
  return todos
}
export function removeTodo(todos, id) {
  todos.splice(todos.findIndex(t => t.id === id), 1)
  return todos
}
```

```js solution
export function addTodo(todos, text) {
  const id = Math.max(0, ...todos.map(t => t.id)) + 1
  return [...todos, { id, text, done: false }]
}
export function toggleTodo(todos, id) {
  return todos.map(t => (t.id === id ? { ...t, done: !t.done } : t))
}
export function removeTodo(todos, id) {
  return todos.filter(t => t.id !== id)
}
```

```js tests
const make = () => [{ id: 1, text: 'a', done: false }, { id: 5, text: 'b', done: true }]
test('addTodo returns a new array with the next id', () => {
  const list = make()
  const next = addTodo(list, 'c')
  expect(next).not.toBe(list)
  expect(list).toHaveLength(2)
  expect(next[2]).toEqual({ id: 6, text: 'c', done: false })
})
test('addTodo on an empty list starts at 1', () => {
  expect(addTodo([], 'x')[0].id).toBe(1)
})
test('toggleTodo flips done immutably', () => {
  const list = make()
  const next = toggleTodo(list, 1)
  expect(next[0].done).toBe(true)
  expect(list[0].done).toBe(false)
  expect(next[0]).not.toBe(list[0])
})
test('toggleTodo keeps untouched items by reference', () => {
  const list = make()
  expect(toggleTodo(list, 1)[1]).toBe(list[1])
})
test('removeTodo drops the item without mutating', () => {
  const list = make()
  const next = removeTodo(list, 5)
  expect(next).toEqual([{ id: 1, text: 'a', done: false }])
  expect(list).toHaveLength(2)
})
```
:::

## Equality and copying in one picture

Primitives (`number`, `string`, `boolean`, …) are compared by **value**. Objects and arrays are
compared by **reference** — "is this the very same object in memory?" — never by contents:

```js
console.log(1 === 1)                // true  — same value
console.log([1, 2] === [1, 2])      // false — two different arrays that happen to look alike
const a = [1, 2]
console.log(a === a)                // true  — same reference
console.log([...a] === a)           // false — spreading always creates a new array
const b = a                         // NOT a copy: b and a are the same array
b.push(3)                           // a is now [1, 2, 3] too
```

:::tip title="Semicolon-free code and lines starting with [ or ("
Without semicolons, JavaScript joins a line that starts with `[` or `(` onto the previous one:
`a === a` followed by a line `[...a] === a` is parsed as `a === a[...a] === a` (a syntax error).
In semicolon-free code, never start a statement with `[` or `(` (formatters like Prettier add a
leading `;` for you when you must).
:::

This is why "I changed the state but the component didn't re-render" (mutation, same reference)
and "my effect runs on every render" (a new object/array literal each render) are two sides of the
same coin. Keep it in mind for the React lessons.

:::challenge id=fe-01-c4 lang=js xp=30
title: Tag cloud with flatMap
Each post has a `tags` array (maybe missing). Write `tagCloud(posts)` returning an array of
`{ tag, count }`, sorted by `count` descending, then `tag` alphabetically. Tags are
case-insensitive: `'React'` and `'react'` are the same tag (output lowercase).

hint: `posts.flatMap(p => p.tags ?? [])` gives one flat list of tags.
hint: Count with `reduce` into an object (then `Object.entries(obj)`) or a `Map` (then `[...map]` / `map.entries()`), and map each pair to `{ tag, count }`.
hint: Sort with `(a, b) => b.count - a.count || a.tag.localeCompare(b.tag)`.

```js starter
export function tagCloud(posts) {
  return []
}
```

```js solution
export function tagCloud(posts) {
  const counts = posts
    .flatMap(p => p.tags ?? [])
    .map(t => t.toLowerCase())
    .reduce((acc, t) => acc.set(t, (acc.get(t) ?? 0) + 1), new Map())
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
```

```js tests
test('counts and sorts tags', () => {
  const posts = [{ tags: ['react', 'ts'] }, { tags: ['React', 'css'] }, { tags: ['ts', 'react'] }]
  expect(tagCloud(posts)).toEqual([
    { tag: 'react', count: 3 },
    { tag: 'ts', count: 2 },
    { tag: 'css', count: 1 },
  ])
})
test('ties are alphabetical', () => {
  expect(tagCloud([{ tags: ['b', 'a', 'c'] }]).map(t => t.tag)).toEqual(['a', 'b', 'c'])
})
test('posts without tags are fine', () => {
  expect(tagCloud([{}, { tags: ['x'] }])).toEqual([{ tag: 'x', count: 1 }])
})
test('empty input', () => {
  expect(tagCloud([])).toEqual([])
})
```
:::

:::quiz id=fe-01-q4 xp=10
A teammate writes this inside a React component. What's the problem?

```js
const sorted = items.sort((a, b) => a.price - b.price)
```

- [ ] Nothing — `sort` returns a new array
- [x] `sort` reorders `items` in place, so it mutates props/state that React (and other components) still hold
- [ ] `sort` cannot take a comparator
> `Array.prototype.sort` mutates and returns the *same* array, so `sorted === items` — the
> tempting "it returns a new array" is exactly the misconception. The comparator is fine. Use
> `items.toSorted(...)` or `[...items].sort(...)`.
:::

:::quiz id=fe-01-q5 xp=10
What does this log?

```js
const fns = []
for (var i = 0; i < 3; i++) {
  fns.push(() => i)
}
console.log(fns.map(f => f()))
```

- [ ] `[0, 1, 2]`
- [x] `[3, 3, 3]`
- [ ] `[undefined, undefined, undefined]`
- [ ] It throws a `ReferenceError`
> `var` is function scoped, so there is only **one** `i` shared by all three arrows. They read it
> when called — after the loop finished and `i` is `3`. `[0, 1, 2]` is what you'd get with
> `let i`, which creates a fresh binding per iteration.
:::

:::quiz id=fe-01-q6 xp=10
A product can be free. Which line shows `0` for a free product and `'n/a'` only when the price is missing?

```js
const product = { name: 'Sticker', price: 0 }
```

- [ ] `product.price || 'n/a'`
- [x] `product.price ?? 'n/a'`
- [ ] `product?.price || 'n/a'`
- [ ] `product.price && 'n/a'`
> `??` falls back only for `null`/`undefined`, so `0` survives. `||` treats `0` as falsy and
> replaces it — adding `?.` doesn't change that, it only protects against `product` itself being
> nullish. `&&` returns `0` here but would return `'n/a'` for every *non-zero* price.
:::

:::pro title="How seniors keep code immutable"
- Treat function arguments as read-only. If a helper needs to change data, it returns a new value.
- Reach for `map`/`filter`/`toSorted`/spread first; a `for` loop that pushes into a *local* array is
  also fine — the rule is about not mutating data you **received**.
- For deeply nested updates, teams use **Immer** (`produce(draft => { draft.a.b = 1 })`), which lets
  you write "mutating" code that produces an immutable copy. Redux Toolkit uses it internally.
:::

:::cards id=fe-01-cards1 xp=15 title="Modern JS essentials"
Q: `const` vs `let`?
A: Both block-scoped. `const` cannot be reassigned (the value may still be mutable); `let` can. Default to `const`.
Q: `??` vs `||`?
A: `??` falls back only on `null`/`undefined`; `||` on any falsy value (`0`, `''`, `false`, `NaN` too).
Q: What does `a?.b?.()` do?
A: Returns `undefined` instead of throwing if `a` is nullish or `a.b` is not there; otherwise calls `a.b()`.
Q: Spread vs rest?
A: Same `...` syntax. Spread expands values (`[...arr]`, `{...obj}`); rest collects them (`(...args)`, `const { a, ...rest } = obj`).
Q: Is `{ ...obj }` a deep copy?
A: No, shallow. Nested objects are shared. Use nested spreads or `structuredClone`.
Q: Non-mutating versions of sort / reverse / splice / index assignment?
A: `toSorted`, `toReversed`, `toSpliced`, `with(i, v)`.
Q: Why does React want immutable updates?
A: It detects changes by reference (`Object.is`). A mutated object is the same reference, so React thinks nothing changed.
Q: `[].every(fn)` returns?
A: `true` (vacuous truth). `[].some(fn)` returns `false`.
Q: Why does `for (var i …) setTimeout(() => log(i))` log the final value every time?
A: `var` is function scoped: one shared `i`. `let` creates a new binding per loop iteration.
Q: Does a destructuring default apply when the value is `null`?
A: No — only for `undefined`. Use `?? fallback` when an API may send `null`.
:::

## Recap

- `const` by default, `let` when reassigning, never `var`; `const` does not make values immutable.
- Arrow functions take `this` from where they are written, not how they are called.
- Destructuring and spread/rest are everywhere in React (props, hooks, state updates). Defaults fire only on `undefined`; spread is shallow.
- `?.` stops at `null`/`undefined`; `??` gives defaults without eating `0` and `''`.
- ES modules: named vs default exports, live bindings, singletons, `import()` for code splitting.
- `map`/`filter`/`find`/`some`/`every`/`reduce`/`flatMap` return new values — the backbone of rendering.
- Prefer non-mutating operations (`toSorted`, `with`, spread). React compares by reference.
