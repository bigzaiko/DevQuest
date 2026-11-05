---
id: fe-02
title: Async JavaScript
level: beginner
minutes: 40
xp: 120
summary: The event loop, promises, async/await, fetch, error handling, Promise combinators and cancelling with AbortController.
---

Every frontend talks to a backend, and every network call is **asynchronous**: you ask for data
now and get it "later". JavaScript runs your code on a **single thread**, so it can't just sit and
wait — the whole page would freeze. This lesson explains how JavaScript juggles "later" work, and
how to write async code that is correct, readable and cancellable.

## The event loop in five sentences

1. JavaScript runs one thing at a time on the **call stack**.
2. Slow things (timers, network, user input) are handed to the browser, which works on them *outside* your code.
3. When they finish, a callback is put in a queue: **tasks** (a.k.a. macrotasks: `setTimeout`, events, network) or **microtasks** (promise callbacks: `.then`, `await` continuations, `queueMicrotask`).
4. When the call stack is empty, the event loop first drains **all** microtasks (including ones queued while draining), then takes **one** task, drains microtasks again, gives the browser a chance to render… and repeats.
5. So promise callbacks always run before the next `setTimeout`, even a `setTimeout(fn, 0)`.

Think of it as a restaurant with one chef (the call stack). Microtasks are "finish this dish
right now" notes; tasks are new orders. The chef clears every note before taking the next order —
and the dining room (the screen) is only tidied between orders.

```js
console.log('A')
setTimeout(() => console.log('B'), 0)     // task queue
Promise.resolve().then(() => console.log('C'))  // microtask queue
console.log('D')
// A, D, C, B
```

`A` and `D` are synchronous. When the script finishes, microtasks run (`C`), then the next task (`B`).

:::info title="Why should a React dev care?"
Because "why is my state not updated yet?", "why did my loading spinner never show?" and "why is
the UI frozen?" are all event-loop questions. A long synchronous loop (say, sorting 200 000 rows)
blocks rendering *and* input until it returns — no amount of `async` keyword fixes that; only
doing less work, chunking it, or moving it to a Web Worker does.
:::

:::quiz id=fe-02-q1 xp=15
What does this log?

```js
setTimeout(() => console.log(1), 0)
Promise.resolve()
  .then(() => console.log(2))
  .then(() => console.log(3))
console.log(4)
```

- [ ] `1 2 3 4`
- [ ] `4 1 2 3`
- [x] `4 2 3 1`
- [ ] `2 3 4 1`
> `4` is synchronous. Then the microtask queue is drained completely — `2`, and the `.then` it
> schedules, `3` — before the event loop picks the next task, the timer: `1`. `2 3 4 1` is wrong
> because even an already-resolved promise never runs its `.then` callback synchronously; and
> `4 1 2 3` is wrong because a `0` ms timer is still a *task*, which waits for all microtasks.
:::

## Promises

A **promise** is an object representing a value that isn't there yet. It is in one of three
states: **pending**, **fulfilled** (has a value) or **rejected** (has an error). Once settled, it
never changes again.

```js
const p = new Promise((resolve, reject) => {
  setTimeout(() => resolve('done'), 500)
})

p.then(value => console.log(value))     // 'done' after 500ms
 .catch(err => console.error(err))      // runs if anything above rejected/threw
 .finally(() => console.log('cleanup')) // runs either way
```

Key rules:

- `.then` returns a **new promise**, resolved with whatever the callback returns. If the callback
  returns a promise, the chain waits for it. That's what makes chaining work.
- Throwing inside `.then` rejects the returned promise; the next `.catch` handles it.
- A rejected promise with no handler shows up as an "Uncaught (in promise)" error in the browser
  console. In Node.js it is worse: an unhandled rejection **crashes the process** by default.

A classic chaining mistake is forgetting to `return` the inner promise:

```js
getUser()
  .then(user => { fetchOrders(user.id) })      // ❌ block body, no return → next .then gets undefined
  .then(orders => console.log(orders))         // logs undefined, and errors from fetchOrders are lost

getUser()
  .then(user => fetchOrders(user.id))          // ✅ returned, so the chain waits for it
  .then(orders => console.log(orders))
```

You rarely call `new Promise` yourself — mostly to wrap a callback API, like a timer:

```js
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
await delay(500)   // pause this async function for half a second
```

## async / await

`async`/`await` is syntax on top of promises that lets async code read top-to-bottom:

```js
async function loadUser(id) {
  const res = await fetch(`/api/users/${id}`)   // pause this function until the promise settles
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()                             // an async function always returns a promise
}

try {
  const user = await loadUser(7)
  console.log(user.name)
} catch (err) {
  console.error('Could not load user', err)
}
```

- An `async` function **always** returns a promise. `return x` resolves it with `x`; `throw e` rejects it.
- `await` pauses only *this* function. The rest of the app keeps running; the code after `await` runs later as a microtask.
- `await` on a rejected promise **throws** at that line, so ordinary `try / catch / finally` handles errors.
- `await` works inside `async` functions and at the top level of ES modules — not inside a plain
  callback like `forEach(item => { await … })` (syntax error) unless that callback is itself `async`.
- Calling an async function **without** `await` doesn't wait and doesn't catch: `save(); navigate('/')`
  navigates before saving finishes, and a failure becomes an unhandled rejection.

:::quiz id=fe-02-q2 xp=15
What does this log?

```js
async function run() {
  console.log('1')
  await null
  console.log('2')
}
run()
console.log('3')
```

- [ ] `1 2 3`
- [x] `1 3 2`
- [ ] `3 1 2`
> An async function runs **synchronously until its first `await`**, so `1` prints immediately
> (that rules out `3 1 2`). `await null` — even on a non-promise — schedules the rest of `run` as
> a microtask, so `3` (sync) prints before `2` (that rules out `1 2 3`).
:::

## fetch and HTTP errors

`fetch` is the browser's built-in HTTP client. Its error model surprises everyone once:

:::warn title="fetch does not reject on 404 or 500"
The promise from `fetch` only rejects on **network failure** (offline, DNS, CORS blocked, aborted).
A `404` or `500` response *fulfills* normally — you must check `res.ok` (status 200–299) yourself.
Why? From the HTTP point of view the request *worked*: the server answered. Whether a `404` is an
error is your app's decision.
:::

```js
const res = await fetch('/api/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ productId: 3, qty: 2 }),
})
if (!res.ok) {
  // ASP.NET Core APIs usually answer errors with "problem details" JSON
  // (RFC 9457, Content-Type: application/problem+json) — worth reading
  const problem = await res.json().catch(() => null)   // the body may not be JSON at all
  throw new Error(problem?.title ?? `HTTP ${res.status}`)
}
const order = await res.json()
```

Note that `res.json()` *also* returns a promise: `fetch` resolves as soon as the **headers**
arrive, and the body streams in afterwards. Two more gotchas:

- The body can be read **once**. Calling `res.json()` and then `res.text()` rejects with a
  `TypeError` ("body stream already read"); use `res.clone()` if you really need both.
- With a JSON body you must set `Content-Type: application/json` yourself and `JSON.stringify`
  the object — `fetch` doesn't do it for you. Without the header ASP.NET Core answers `415 Unsupported Media Type`.

:::challenge id=fe-02-c1 lang=js xp=40
title: A fetchJson helper
Every codebase has one of these. Write `fetchJson(url, fetcher)` that:

- calls `fetcher(url)` (it behaves like `fetch` — we inject it so it's testable)
- returns the parsed JSON body when `res.ok`
- otherwise throws an `Error` whose message is `HTTP <status>` (e.g. `HTTP 404`)

hint: `const res = await fetcher(url)`
hint: ``if (!res.ok) throw new Error(`HTTP ${res.status}`)`` then `return res.json()`.

```js starter
export async function fetchJson(url, fetcher) {
  const res = await fetcher(url)
  return res.json()
}
```

```js solution
export async function fetchJson(url, fetcher) {
  const res = await fetcher(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
```

```js tests
const okFetcher = (body) => fn(async () => ({ ok: true, status: 200, json: async () => body }))
const errFetcher = (status) => fn(async () => ({ ok: false, status, json: async () => ({ title: 'nope' }) }))

test('returns parsed JSON', async () => {
  await expect(fetchJson('/api/a', okFetcher({ id: 1 }))).resolves.toEqual({ id: 1 })
})
test('passes the url through', async () => {
  const f = okFetcher({})
  await fetchJson('/api/users/7', f)
  expect(f).toHaveBeenCalledWith('/api/users/7')
})
test('throws on 404', async () => {
  await expect(fetchJson('/x', errFetcher(404))).rejects.toThrow('HTTP 404')
})
test('throws on 500', async () => {
  await expect(fetchJson('/x', errFetcher(500))).rejects.toThrow('HTTP 500')
})
```
:::

:::quiz id=fe-02-q4 xp=10
The API returns `404 Not Found` with a JSON body. What happens?

```js
try {
  const res = await fetch('/api/users/999')
  const user = await res.json()
  render(user)
} catch {
  showError()
}
```

- [ ] `fetch` rejects, so `showError()` runs
- [x] `fetch` fulfills; `render` is called with the 404's error JSON
- [ ] `res.json()` throws because the status is 404
- [ ] The browser retries the request automatically
> `fetch` only rejects on network-level failures. A 404 is a valid HTTP response, so `res` is
> fulfilled with `res.ok === false`, and `res.json()` happily parses whatever JSON the server sent
> — here, the error body. The fix is an `if (!res.ok) throw …` before parsing.
:::

## Sequential vs parallel

A common performance bug is awaiting independent requests one after the other:

```js
// ❌ sequential: total time = a + b + c
const user = await getUser()
const orders = await getOrders()
const prefs = await getPrefs()
```

```js
// ✅ parallel: total time = max(a, b, c)
const [user, orders, prefs] = await Promise.all([getUser(), getOrders(), getPrefs()])

// the same for a list: start one request per id, then wait for all
const products = await Promise.all(ids.map(id => getProduct(id)))
```

The trick: calling `getUser()` *starts* the request; `await` only *waits* for it. Start everything
first, then wait for all. Stay sequential only when a request **needs the result** of the previous
one (e.g. load the user, then their orders by `user.id`).

:::warn title="Two gotchas with parallel work"
- `Promise.all` fails fast, but it **doesn't cancel** the other requests — they keep running; their
  results are just ignored. Cancel them yourself with an `AbortController` (below) if that matters.
- Starting promises early and awaiting them one by one (`const a = getA(); const b = getB(); await a; await b`)
  looks parallel, but if `b` rejects while you are still awaiting `a`, nothing is listening to `b` yet
  → an unhandled rejection (a console error in the browser, a process crash in Node). `Promise.all` attaches handlers to all of them at once.
:::

## The Promise combinators

| Combinator | Resolves when | Rejects when | Use it for |
|---|---|---|---|
| `Promise.all(ps)` | **all** fulfill → array of values (in input order) | **any** rejects (fail fast) | Things that all must succeed |
| `Promise.allSettled(ps)` | all settle → `[{status, value \| reason}]` | never | Best-effort batches, show partial results |
| `Promise.race(ps)` | the **first** to settle (fulfill *or* reject) | the first settles with a rejection | Timeouts |
| `Promise.any(ps)` | the first to **fulfill** | all reject (`AggregateError`) | Fastest mirror / fallback sources |

How to choose: ask "what should happen when **one** of them fails?" Everything fails → `all`.
Keep the rest → `allSettled`. Whoever answers first wins, success or not → `race`. First
*success* wins, failures only matter if all fail → `any`.

```js
const results = await Promise.allSettled([getA(), getB()])
for (const r of results) {
  if (r.status === 'fulfilled') show(r.value)
  else console.warn(r.reason)
}
```

:::challenge id=fe-02-c2 lang=js xp=40
title: Load a dashboard in parallel
Write `loadDashboard(api)` where `api` has three async methods: `user()`, `orders()`, `notifications()`.

- Start all three **at the same time** and return `{ user, orders, notifications }`.
- `user` and `orders` are required: if either fails, `loadDashboard` rejects.
- `notifications` is optional: if it fails, use an empty array `[]` instead.

hint: The tests measure time — awaiting one after another is too slow. Call all three methods first, then wait.
hint: Attaching `.catch(() => [])` to just the notifications promise turns its failure into a value *before* `Promise.all` sees it.
hint: `Promise.all([api.user(), api.orders(), api.notifications().catch(() => [])])`

```js starter
export async function loadDashboard(api) {
  const user = await api.user()
  const orders = await api.orders()
  const notifications = await api.notifications()
  return { user, orders, notifications }
}
```

```js solution
export async function loadDashboard(api) {
  const [user, orders, notifications] = await Promise.all([
    api.user(),
    api.orders(),
    api.notifications().catch(() => []),
  ])
  return { user, orders, notifications }
}
```

```js tests
const wait = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))
const failAfter = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('boom')), ms))

test('returns all three', async () => {
  const api = { user: () => wait(10, 'ada'), orders: () => wait(10, [1]), notifications: () => wait(10, ['hi']) }
  await expect(loadDashboard(api)).resolves.toEqual({ user: 'ada', orders: [1], notifications: ['hi'] })
})
test('runs in parallel', async () => {
  const api = { user: () => wait(100, 'u'), orders: () => wait(100, []), notifications: () => wait(100, []) }
  const start = Date.now()
  await loadDashboard(api)
  expect(Date.now() - start).toBeLessThan(250)
})
test('failing notifications become []', async () => {
  const api = { user: () => wait(5, 'u'), orders: () => wait(5, []), notifications: () => failAfter(5) }
  await expect(loadDashboard(api)).resolves.toEqual({ user: 'u', orders: [], notifications: [] })
})
test('failing orders rejects', async () => {
  const api = { user: () => wait(5, 'u'), orders: () => failAfter(5), notifications: () => wait(5, []) }
  await expect(loadDashboard(api)).rejects.toThrow('boom')
})
```
:::

:::challenge id=fe-02-c3 lang=js xp=40
title: withTimeout via Promise.race
Write `withTimeout(promise, ms)`: it resolves/rejects like `promise`, unless `ms` milliseconds pass
first — then it rejects with `new Error('Timeout')`. Clear the timer once the race is over (a good
habit; lingering timers keep Node processes alive and waste work in the browser).

hint: Build a second promise that rejects after `ms` with `setTimeout`.
hint: `Promise.race([promise, timeout]).finally(() => clearTimeout(id))`

```js starter
export function withTimeout(promise, ms) {
  return promise
}
```

```js solution
export function withTimeout(promise, ms) {
  let id
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error('Timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id))
}
```

```js tests
const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))
test('resolves when fast enough', async () => {
  await expect(withTimeout(later(10, 'ok'), 200)).resolves.toBe('ok')
})
test('rejects with Timeout when too slow', async () => {
  await expect(withTimeout(later(300, 'late'), 30)).rejects.toThrow('Timeout')
})
test('passes through the original rejection', async () => {
  await expect(withTimeout(Promise.reject(new Error('db down')), 100)).rejects.toThrow('db down')
})
```
:::

## Error handling patterns

- **Always handle rejections** somewhere: a `try/catch` around `await`, or a `.catch()` at the end of the chain.
- **Catch where you can do something useful** (show an error state, retry, fall back). Catching
  just to `console.log` and continue usually hides bugs.
- `finally` is the place to reset loading flags: `setLoading(false)` must run on success *and* failure.
- Throw `Error` objects, not strings — you get a stack trace and `err.message`.

```js
async function save(order) {
  setSaving(true)
  try {
    await api.saveOrder(order)
    toast('Saved!')
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Unknown error')
  } finally {
    setSaving(false)
  }
}
```

:::challenge id=fe-02-c4 lang=js mode=tests xp=60
title: Test a retry helper
`retry(task, attempts)` calls the async `task()` up to `attempts` times. It resolves with the first
successful result; if every attempt fails, it rejects with the **last** error. It must stop calling
`task` as soon as one call succeeds.

Write tests that pass against the correct implementation and catch all three hidden bugs. Mocks help:
`fn()` records calls, and `.mockImplementation(...)` lets you script behaviour.

hint: Make a task that fails twice then succeeds: keep a counter in a closure.
hint: Assert how many times the task was called (`toHaveBeenCalledTimes`).
hint: Test the "all attempts fail" case with `await expect(retry(...)).rejects.toThrow('...')` and use different messages per attempt.

```js impl
export async function retry(task, attempts) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return await task()
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}
```

```js mutant
export async function retry(task, attempts) {
  let lastError
  for (let i = 0; i < attempts - 1; i++) {
    try {
      return await task()
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}
```

```js mutant
export async function retry(task, attempts) {
  let firstError
  for (let i = 0; i < attempts; i++) {
    try {
      return await task()
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError
}
```

```js mutant
export async function retry(task, attempts) {
  let lastError
  let result
  let ok = false
  for (let i = 0; i < attempts; i++) {
    try {
      result = await task()
      ok = true
    } catch (err) {
      lastError = err
    }
  }
  if (ok) return result
  throw lastError
}
```

```js starter
test('returns the value when the first call succeeds', async () => {
  const task = fn(async () => 42)
  // await expect(retry(task, 3))...
})
```

```js solution
test('returns the value when the first call succeeds', async () => {
  const task = fn(async () => 42)
  await expect(retry(task, 3)).resolves.toBe(42)
  expect(task).toHaveBeenCalledTimes(1)
})
test('retries until it succeeds', async () => {
  let n = 0
  const task = fn(async () => {
    n++
    if (n < 3) throw new Error('fail ' + n)
    return 'ok'
  })
  await expect(retry(task, 3)).resolves.toBe('ok')
  expect(task).toHaveBeenCalledTimes(3)
})
test('rejects with the last error', async () => {
  let n = 0
  const task = fn(async () => { n++; throw new Error('fail ' + n) })
  await expect(retry(task, 3)).rejects.toThrow('fail 3')
  expect(task).toHaveBeenCalledTimes(3)
})
```
:::

## Cancelling with AbortController

Users click fast. They type "r", "re", "rea", "reac" in a search box and you fire four requests.
Responses can come back **out of order** — if "re" arrives after "reac", you show the wrong results.
Also, a component may unmount while its request is in flight. The browser's answer is
**`AbortController`**:

```js
const controller = new AbortController()

fetch('/api/search?q=react', { signal: controller.signal })
  .then(res => res.json())
  .then(showResults)
  .catch(err => {
    if (err.name === 'AbortError') return   // we cancelled it on purpose — not an error
    showError(err)
  })

controller.abort()   // cancels the request; fetch rejects with an AbortError
```

- One controller → one `signal` → pass it to any number of `fetch` calls (or your own code: `signal.aborted`, `signal.addEventListener('abort', …)`).
- A controller can only abort once. Create a new one for each new request.
- `AbortSignal.timeout(5000)` gives you a signal that aborts itself after 5s — the modern way to put
  a timeout on `fetch`. Note the error is then named **`TimeoutError`**, not `AbortError`, so the
  "ignore our own cancel" check above still reports timeouts to the user — usually what you want.
- `AbortSignal.any([a, b])` combines signals (user cancel **or** timeout).
- Aborting stops *waiting* and frees the connection; it does not undo work the server already did.
  An aborted `POST /orders` may still have created the order.

```js
const cancel = new AbortController()   // wired to a "Cancel" button
const res = await fetch('/api/report', {
  signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]),
})
```

In React you'll create a controller inside `useEffect` and call `abort()` in the cleanup — see the
Effects lesson.

:::challenge id=fe-02-c5 lang=js xp=50
title: Latest-only search
Write `createSearch(fetcher)` that returns a `search(query)` function. Each call to `search`:

- **aborts the previous in-flight request** (if any),
- calls `fetcher(query, signal)` with a fresh `AbortSignal`,
- returns the fetcher's promise.

hint: Keep `let controller = null` in the closure created by `createSearch`.
hint: In `search`: `controller?.abort()`, then `controller = new AbortController()`.

```js starter
export function createSearch(fetcher) {
  return function search(query) {
    return fetcher(query)
  }
}
```

```js solution
export function createSearch(fetcher) {
  let controller = null
  return function search(query) {
    controller?.abort()
    controller = new AbortController()
    return fetcher(query, controller.signal)
  }
}
```

```js tests
test('passes query and a signal', async () => {
  const f = fn(async () => [])
  const search = createSearch(f)
  await search('re')
  expect(f.mock.calls[0][0]).toBe('re')
  expect(f.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
})
test('aborts the previous request', () => {
  const f = fn(() => new Promise(() => {}))
  const search = createSearch(f)
  search('r')
  search('re')
  const [first, second] = f.mock.calls.map((c) => c[1])
  expect(first.aborted).toBe(true)
  expect(second.aborted).toBe(false)
})
test('uses a new signal each time', () => {
  const f = fn(() => new Promise(() => {}))
  const search = createSearch(f)
  search('a'); search('b'); search('c')
  const signals = f.mock.calls.map((c) => c[1])
  expect(new Set(signals).size).toBe(3)
  expect(signals.filter((s) => s.aborted)).toHaveLength(2)
})
test('separate searches are independent', () => {
  const f = fn(() => new Promise(() => {}))
  const a = createSearch(f)
  const b = createSearch(f)
  a('x'); b('y')
  expect(f.mock.calls[0][1].aborted).toBe(false)
})
```
:::

:::quiz id=fe-02-q3 xp=10
You need the results of 5 independent API calls and want to **show whatever succeeded**, even if
some fail. Which combinator?

- [ ] `Promise.all`
- [x] `Promise.allSettled`
- [ ] `Promise.race`
- [ ] `Promise.any`
> `allSettled` never rejects; it gives you `{ status: 'fulfilled', value }` or
> `{ status: 'rejected', reason }` for each input, so you can render partial results.
> `Promise.all` is the tempting pick, but it rejects as soon as one fails and you lose the other
> results. `race` and `any` give you only a single result.
:::

:::quiz id=fe-02-q5 xp=15
Spot the bug. This should save every item and *then* show "All saved":

```js
async function saveAll(items) {
  items.forEach(async (item) => {
    await api.save(item)
  })
  toast('All saved')
}
```

- [ ] Nothing — `await` inside the callback makes `forEach` wait
- [x] `forEach` ignores the promises the async callback returns, so the toast shows before the saves finish and failures go unhandled
- [ ] It's a syntax error: `await` can't appear inside `forEach`
- [ ] The saves run one after another, which is just slow
> `forEach` calls the callback and throws away its return value — here a promise — so `saveAll`
> never waits. It is *not* a syntax error, because the callback itself is `async`. The saves do
> start in parallel, but nobody awaits them. Fix: `await Promise.all(items.map(item => api.save(item)))`
> (parallel) or a `for (const item of items) await api.save(item)` loop (sequential).
:::

:::quiz id=fe-02-q6 xp=10
`await Promise.all([a(), b(), c()])` — request `b` fails after 100 ms; `a` and `c` take 2 s. What happens?

- [x] The `await` throws `b`'s error after ~100 ms; `a` and `c` keep running in the background
- [ ] The `await` throws after 2 s, once everything has settled
- [ ] `a` and `c` are cancelled automatically when `b` fails
- [ ] It resolves with `[resultA, undefined, resultC]`
> `Promise.all` is **fail fast**: it rejects with the first rejection immediately. But promises
> are not cancellable — the other requests continue and their results are simply discarded. Waiting
> for everything is `allSettled`'s behaviour; partial `undefined` results never happen with `all`.
:::

:::job title="What reviewers flag in async code"
- `await` inside a `for` loop over independent items (should be `Promise.all`; ESLint `no-await-in-loop` flags it).
- `items.forEach(async …)` — nothing waits for those promises.
- Missing `res.ok` check after `fetch`.
- A `.then()` chain without `.catch()`, or `async` event handlers with no error handling.
- "Fire and forget" promises — ESLint's `@typescript-eslint/no-floating-promises` catches them.
- Requests that are never cancelled when the user navigates away.
:::

:::pro title="Don't hand-roll a data layer forever"
Real React apps rarely call `fetch` directly from components. Teams use **TanStack Query** (or
SWR/RTK Query) which handles caching, deduping, retries, cancellation and loading/error state.
Understanding promises and `AbortController` is what lets you debug those libraries when they
surprise you.
:::

:::cards id=fe-02-cards1 xp=15 title="Async JavaScript"
Q: Microtask vs task?
A: Microtasks = promise callbacks / `await` continuations; tasks = `setTimeout`, events, I/O. All microtasks run before the next task.
Q: Does `fetch` reject on HTTP 500?
A: No. It only rejects on network errors or abort. Check `res.ok` / `res.status`.
Q: What does an `async` function return?
A: Always a promise. `return x` → fulfilled with `x`; `throw e` → rejected with `e`.
Q: `Promise.all` vs `allSettled`?
A: `all` rejects on the first failure (fail fast); `allSettled` waits for all and reports each outcome.
Q: How to run independent requests in parallel?
A: Start them all, then `await Promise.all([...])`.
Q: How do you cancel a fetch?
A: Pass `signal` from an `AbortController`; call `controller.abort()`. The fetch rejects with `AbortError`.
Q: Why might search results show the wrong query?
A: Responses can arrive out of order. Abort the old request (or ignore stale responses).
Q: Does `items.forEach(async x => await save(x))` wait for the saves?
A: No. `forEach` ignores returned promises. Use `await Promise.all(items.map(x => save(x)))` or a `for…of` loop with `await`.
Q: When `Promise.all` rejects, are the other promises cancelled?
A: No. They keep running; their results are ignored. Use an `AbortSignal` to really cancel.
:::

## Recap

- JavaScript is single-threaded; the event loop drains microtasks (promises) before the next task (timers, events).
- Promises have three states; `.then` returns a new promise; `async`/`await` is sugar over that.
- `fetch` only rejects on network failure — always check `res.ok`.
- Start independent work in parallel; pick `all`, `allSettled`, `race` or `any` by the failure semantics you need.
- Handle errors where you can act on them; reset loading flags in `finally`.
- `AbortController` cancels requests and prevents out-of-order responses; `AbortSignal.timeout` adds timeouts.
- `forEach` never awaits async callbacks; `Promise.all` fails fast but doesn't cancel the others.
