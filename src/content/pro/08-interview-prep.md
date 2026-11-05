---
id: pro-08
title: Interview Prep Across the Stack
level: advanced
minutes: 75
xp: 270
summary: A dense refresher for full-stack interviews — JS/TS, React, C#/.NET, SQL, HTTP, Docker/K8s, system design and STAR stories — with tricky quizzes, classic coding problems and big flashcard decks.
---

This lesson is a **refresher**, not a first introduction. It collects the questions that come up
again and again in full-stack interviews for a React + TypeScript + ASP.NET Core + PostgreSQL
role, the traps hidden in them, and a handful of classic live-coding problems. Use it the week
before an interview, and come back to the flashcards the evening before.

:::job title="What a typical interview loop looks like"
1. **Recruiter / HR call** (20–30 min): motivation, salary range, notice period.
2. **Technical screen** (45–60 min): knowledge questions + a small coding task, often shared editor.
3. **Take-home or live coding** (1–3 h): build a small feature or API; code quality matters more than cleverness.
4. **System design** (45–60 min, for mid/senior roles): design a small product end-to-end.
5. **Behavioural / team fit** (45 min): STAR stories about conflict, failure, ownership.
6. **Meet the team / hiring manager**: your chance to interview *them*.
:::

## How to answer technical questions

Interviewers aren't only checking whether you know the answer. They check whether you can
**explain** it, know **when it matters**, and are honest about the edges of your knowledge.

A good answer has three parts:

1. **Definition** in one or two sentences.
2. **Why it matters / an example** from real code ("we had a bug where…").
3. **Trade-off or gotcha** ("…but be careful with X").

> Q: "What's the difference between `useMemo` and `useCallback`?"
>
> A: "`useMemo` caches a computed **value**, `useCallback` caches a **function** reference —
> `useCallback(fn, deps)` is just `useMemo(() => fn, deps)`. I use them when referential
> stability matters, like a prop to a `memo` component or a dependency of an effect. They aren't
> free, so I don't wrap everything — and with the React Compiler a lot of manual memoisation
> goes away."

:::pro title="Saying 'I don't know' well"
"I haven't used that directly. My understanding is … and I'd verify by …" beats bluffing every
time. Interviewers probe until you hit the edge of your knowledge — reaching it is expected.
:::

## JavaScript & TypeScript

The core topics: **scope and closures**, **`this`**, the **event loop** (call stack, microtasks,
macrotasks), **promises and async/await**, **equality and coercion**, **prototypes**, **immutability**
(spread copies are shallow), and in TypeScript: **structural typing**, **unions and narrowing**,
**generics**, **utility types** (`Partial`, `Pick`, `Omit`, `Record`), `unknown` vs `any`, and
`type` vs `interface`.

The event loop is the single most-asked "tricky" topic. The rule: run all synchronous code, then
drain **all microtasks** (promise callbacks, `queueMicrotask`, code after `await`), then run
**one macrotask** (timer, I/O, message), drain microtasks again, render, repeat.

:::quiz id=pro-08-q1 xp=15
What does this print?

```js
console.log('A')
setTimeout(() => console.log('B'), 0)
Promise.resolve().then(() => console.log('C'))
;(async () => {
  console.log('D')
  await null
  console.log('E')
})()
console.log('F')
```

- [ ] A B C D E F
- [ ] A D F B C E
- [x] A D F C E B
- [ ] A F D C E B
> Synchronous first: A, then the async function runs synchronously until its first `await` (D),
> then F. Microtasks next, in queue order: C was queued before the `await`, so C, then E (the
> continuation after `await`). The timer is a macrotask, so B is last. The tempting
> `A D F B C E` assumes `setTimeout(…, 0)` means "right now". It actually means "in the next
> macrotask, after every queued microtask".
:::

:::quiz id=pro-08-q2 xp=15
What does this log?

```ts
const fns: (() => number)[] = []
for (var i = 0; i < 3; i++) fns.push(() => i)
console.log(fns.map((f) => f()))
```

- [ ] `[0, 1, 2]`
- [x] `[3, 3, 3]`
- [ ] `[undefined, undefined, undefined]`
- [ ] A TypeError
> `var` is function-scoped, so all three closures share one `i`, which is 3 after the loop.
> The closures read `i` when they're *called* (after the loop), not when they're created. With
> `let`, each iteration gets its own binding and the result is `[0, 1, 2]`.
:::

:::quiz id=pro-08-q12 xp=15
Which of the two marked lines compile?

```ts
type User = { name: string }

const data = { name: 'Ana', admin: true }
const a: User = data                          // line A
const b: User = { name: 'Ana', admin: true }  // line B
```

- [ ] Both: TypeScript is structurally typed, extra properties are always fine
- [x] Only line A: line B fails the excess property check for object literals
- [ ] Only line B: line A loses type information
- [ ] Neither: `admin` isn't part of `User`
> Structural typing makes line A legal: `data` has a `name: string`, so it *is* a `User` as far
> as TypeScript cares. Line B is a **fresh object literal** assigned straight to a type, and
> TypeScript runs an extra *excess property check* there, because an unknown property in a
> literal is almost always a typo (`nmae`). Interviewers like this one because "structural
> typing" alone predicts the wrong answer.
:::

## React

Expect questions on: **rendering and reconciliation** (keys!), **state vs props**, **hooks rules**,
**`useEffect`** (dependencies, cleanup, why it runs twice in Strict Mode dev), **stale closures**,
**controlled vs uncontrolled inputs**, **lifting state / context / external stores**,
**memoisation** (`memo`, `useMemo`, `useCallback`, React Compiler), **data fetching** (TanStack
Query, Suspense), **React 19** (Actions, `useActionState`, `useOptimistic`, `use`), and
**performance** (code splitting with `lazy`, virtualised lists).

:::quiz id=pro-08-q3 xp=15
The counter shows `1` after one click — not `3`. Why?

```tsx
function Counter() {
  const [count, setCount] = useState(0)
  function addThree() {
    setCount(count + 1)
    setCount(count + 1)
    setCount(count + 1)
  }
  return <button onClick={addThree}>{count}</button>
}
```

- [ ] React only allows one `setState` call per event
- [x] Each call uses the `count` captured by this render (0), so all three set it to 1
- [ ] `useState` updates are asynchronous and the last two are dropped
- [ ] The button needs a `key`
> The handler closes over this render's `count`, which is `0`, so it queues "set to 1" three
> times. Use the updater form `setCount((c) => c + 1)` so each update builds on the previous
> one. "Asynchronous and dropped" is the tempting answer, but nothing is dropped: React batches
> all three updates and applies each one. They just all compute the same value. Multiple
> `setState` calls per event are perfectly legal.
:::

:::quiz id=pro-08-q4 xp=15
Which statements about list `key`s are true? (Select all that apply.)
- [x] Keys must be unique among siblings, not globally
- [x] Using the array index as key can mix up component state when items are reordered or removed
- [ ] Keys are passed to the component as `props.key`
- [x] Changing a component's key forces React to unmount it and mount a fresh instance
> `key` is consumed by React and never reaches props. Pass the id separately if the child needs
> it. With index keys, deleting item 0 makes the old item 1 "become" key 0, so it inherits item
> 0's state (a half-typed input, a checked box). "Reset a component by changing its key" is a
> legitimate, handy pattern (e.g. `<EditForm key={user.id} />`).
:::

## C# and .NET

The usual suspects: **value vs reference types** (struct/class/record), **`async`/`await`**
(no `.Result`, no `async void`, `CancellationToken`, `ConfigureAwait`), **LINQ deferred
execution** and `IEnumerable` vs `IQueryable`, **DI lifetimes** (singleton/scoped/transient and
the captive dependency problem), **middleware pipeline order**, **minimal APIs vs controllers**,
**EF Core** (change tracking, `AsNoTracking`, N+1, migrations, concurrency tokens),
**nullable reference types**, **`IDisposable`/`using`**, **exceptions vs result types**, and
**garbage collection** basics (generations, `Span<T>` for fewer allocations).

:::quiz id=pro-08-q5 xp=15
What does this print?

```csharp
var nums = new List<int> { 1, 2, 3 };
var big = nums.Where(n => n > 1);
nums.Add(4);
Console.WriteLine(big.Count());
```

- [ ] 2
- [x] 3
- [ ] 4
- [ ] It throws `InvalidOperationException`
> LINQ is **deferred**: `Where` builds a query that runs when enumerated. By the time `Count()`
> runs, the list is `[1,2,3,4]`, so 2, 3 and 4 match. Call `.ToList()` to snapshot. The
> `InvalidOperationException` ("collection was modified") only happens if you change the list
> *while* enumerating it, for example inside a `foreach` over `big`. Here the `Add` happens
> before enumeration starts.
:::

:::quiz id=pro-08-q6 xp=15
A **singleton** service takes an `AppDbContext` (registered as **scoped**) in its constructor.
What happens?
- [ ] Works fine; the DbContext is recreated per request automatically
- [x] It's a captive dependency: one DbContext lives forever and is shared across requests (in Development, scope validation throws at startup)
- [ ] The DbContext becomes transient
- [ ] Compile error
> A longer-lived service must not hold a shorter-lived one. DbContext isn't thread-safe and its
> change tracker grows forever. Inject `IServiceScopeFactory` (create a scope per unit of work)
> or `IDbContextFactory<T>` instead. It's not a compile error because DI is resolved at runtime.
> In Development, `WebApplication` turns on scope validation, so you get "Cannot consume scoped
> service … from singleton" at startup. In Production that check is off by default, and the bug
> ships silently.
:::

## SQL and PostgreSQL

Know: **JOIN types**, **GROUP BY / HAVING**, **window functions** (`ROW_NUMBER`, `RANK`, running
totals), **CTEs**, **NULL semantics**, **indexes** (B-tree, composite column order, covering,
partial; why an index might not be used), **`EXPLAIN ANALYZE`**, **transactions and isolation
levels**, **ACID**, **normalisation** vs pragmatic denormalisation, **N+1 queries**, **keyset
pagination**, and Postgres specifics (`jsonb`, `RETURNING`, `ON CONFLICT`, `uuid` and
PostgreSQL 18's built-in `uuidv7()`, `timestamptz`).

:::quiz id=pro-08-q7 xp=20
`orders.customer_id` contains a few `NULL`s. How many rows does this return?

```sql
SELECT id FROM customers
WHERE id NOT IN (SELECT customer_id FROM orders);
```

- [ ] All customers without orders
- [x] Zero rows, always
- [ ] All customers
- [ ] An error
> `x NOT IN (1, 2, NULL)` means `x <> 1 AND x <> 2 AND x <> NULL`; the last part is NULL
> (unknown), so the whole condition is never true. `WHERE` keeps only rows where the condition
> is *true*, so no customer survives. That's not an error, just an empty result. Use
> `NOT EXISTS` (NULL-safe) or filter `WHERE customer_id IS NOT NULL` in the subquery.
:::

:::quiz id=pro-08-q8 xp=15
You want **all** customers with their order count, including those with zero orders. What's wrong?

```sql
SELECT c.name, COUNT(o.id)
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'paid'
GROUP BY c.name;
```

- [ ] `COUNT(o.id)` should be `COUNT(*)`
- [x] The `WHERE` on `o.status` removes the NULL rows, turning the LEFT JOIN into an INNER JOIN
- [ ] `GROUP BY` must include `o.id`
- [ ] Nothing, it's correct
> Put the condition into the join: `LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'paid'`.
> Also group by `c.id` (names aren't unique). And `COUNT(*)` would be wrong: it counts 1 for
> customers with no orders.
:::

## HTTP and REST

Must-knows: **methods and their semantics** (safe: GET/HEAD; idempotent: GET/PUT/DELETE; not
idempotent: POST; PATCH: it depends), **status codes** (200, 201 + `Location`, 204, 301/302/304,
400, 401 vs 403, 404, 409, 422, 429, 500, 502/503/504), **headers** (`Cache-Control`, `ETag` /
`If-None-Match`, `Authorization`, `Content-Type`), **cookies** (`HttpOnly`, `Secure`,
`SameSite`), **CORS** (preflight `OPTIONS`), **REST resource design**, **pagination**,
**versioning**, **ProblemDetails** (RFC 9457) error bodies, and the differences between
REST, GraphQL, gRPC, WebSockets/SignalR and Server-Sent Events.

:::quiz id=pro-08-q9 xp=15
Which statements are correct? (Select all that apply.)
- [x] `401` means "not authenticated" (who are you?); `403` means "authenticated but not allowed"
- [x] `PUT /users/7` with the same body twice leaves the server in the same state as once
- [ ] CORS protects your API from requests sent by `curl` or Postman
- [x] A browser sends a preflight `OPTIONS` request before a cross-origin `PUT` with a JSON body
- [ ] `POST` is idempotent by definition
> CORS is enforced by **browsers** only; it controls which origins' JavaScript may read
> responses. It is not an authentication or firewall mechanism, and `curl` ignores it entirely.
> `PUT` isn't a "simple" method and `application/json` isn't a "simple" content type, so the
> browser preflights. `POST` is neither safe nor idempotent: two identical POSTs normally create
> two orders, which is why payment APIs accept an idempotency key.
:::

## Docker and Kubernetes

Know: **image vs container**, **layers and build cache** (copy `*.csproj`/`package.json` first,
restore, then copy source), **multi-stage builds**, **small base images** (`aspnet:10.0`
chiseled, `node:alpine`/distroless, nginx for the SPA), **non-root user**, **`.dockerignore`**,
**volumes vs bind mounts**, **Compose networking** (service names as hostnames), **env vars vs
secrets**. Kubernetes: **Pod, Deployment, ReplicaSet, Service (ClusterIP/NodePort/LoadBalancer),
Ingress, ConfigMap, Secret, Namespace**, **liveness/readiness/startup probes**, **requests and
limits**, **rolling updates and rollbacks**, **HPA**, **StatefulSet** for databases.

:::quiz id=pro-08-q10 xp=15
Your ASP.NET Core container in Kubernetes is restarted every few minutes while the database is
briefly unreachable. The liveness probe calls `/health`, which checks the database. Best fix?
- [ ] Increase the memory limit
- [x] Make liveness check only that the process is alive; put the database check in the readiness probe
- [ ] Remove all probes
- [ ] Switch the Deployment to a StatefulSet
> Liveness failing → **restart**. Readiness failing → **stop sending traffic**. A DB outage
> isn't fixed by restarting your API, and restarting all pods at once makes recovery worse.
:::

:::quiz id=pro-08-q11 xp=15
In a Compose file the API connects to Postgres with `Host=localhost;Port=5432`, and it fails with
"connection refused". The `db` service is running. Why?
- [ ] Postgres doesn't support Docker
- [x] Inside the API container, `localhost` is the API container itself; use the service name `db`
- [ ] Port 5432 must be published with `ports:` for containers to talk to each other
- [ ] The connection string needs `SSL Mode=Require`
> Containers on the same Compose network reach each other by **service name**
> (`Host=db;Port=5432`). Publishing ports is only needed for access from your host machine.
:::

## Classic coding problems

Live-coding rounds favour small, well-known problems. Talk while you code: restate the problem,
ask about edge cases, write the simple version first, then improve, then state the complexity.

:::challenge id=pro-08-c1 lang=ts xp=50
title: Debounce
Implement `debounce(fn, waitMs)`. The returned function delays calling `fn` until `waitMs` have
passed **since the last call**; then it calls `fn` once with the **latest** arguments. It also has
a `cancel()` method that drops a pending call.

This is what you'd use for a search box: only send the request when the user stops typing.

hint: Keep a `let timer: ReturnType<typeof setTimeout> | undefined` in the closure.
hint: On every call: `clearTimeout(timer)` and start a new `setTimeout`.
hint: Attach `cancel` with `Object.assign(debounced, { cancel })` or by setting a property.

```ts starter
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  const debounced = (...args: A) => fn(...args)
  return Object.assign(debounced, { cancel: () => {} })
}
```

```ts solution
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounced = (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fn(...args)
    }, waitMs)
  }
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  return Object.assign(debounced, { cancel })
}
```

```ts tests
test('does not call immediately', () => {
  const spy = fn()
  const d = debounce(spy, 20)
  d('a')
  expect(spy).not.toHaveBeenCalled()
  d.cancel()
})
test('calls once with the latest arguments after a burst', async () => {
  const spy = fn()
  const d = debounce(spy, 20)
  d('a'); d('ab'); d('abc')
  await sleep(50)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith('abc')
})
test('each call restarts the timer', async () => {
  const spy = fn()
  const d = debounce(spy, 30)
  d(1)
  await sleep(15)
  d(2)
  await sleep(15)
  expect(spy).not.toHaveBeenCalled()
  await sleep(40)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(spy).toHaveBeenCalledWith(2)
})
test('separate bursts give separate calls', async () => {
  const spy = fn()
  const d = debounce(spy, 10)
  d('x')
  await sleep(30)
  d('y')
  await sleep(30)
  expect(spy).toHaveBeenCalledTimes(2)
})
test('cancel drops the pending call', async () => {
  const spy = fn()
  const d = debounce(spy, 10)
  d('x')
  d.cancel()
  await sleep(30)
  expect(spy).not.toHaveBeenCalled()
})
```
:::

:::challenge id=pro-08-c2 lang=ts xp=60
title: LRU cache
Implement `class LRUCache<K, V>` with a fixed `capacity`:

- `get(key)` returns the value or `undefined`, and marks the key as **most recently used**.
- `put(key, value)` inserts or updates and marks it most recently used. If the cache grows beyond
  `capacity`, evict the **least recently used** entry.
- `size` getter returns the number of entries.

Both operations should be **O(1)**. In an interview you'd mention the textbook solution (hash map +
doubly linked list); in JavaScript a `Map` keeps insertion order, which gives you a neat shortcut.

hint: A `Map` iterates in insertion order. Deleting and re-inserting a key moves it to the end (= most recent).
hint: The least recently used key is `this.map.keys().next().value`.
hint: In `get`, only re-insert if the key exists — use `has`, because a stored value could be `undefined`.

```ts starter
export class LRUCache<K, V> {
  private map = new Map<K, V>()
  constructor(private capacity: number) {}
  get(key: K): V | undefined {
    return this.map.get(key)
  }
  put(key: K, value: V): void {
    this.map.set(key, value)
  }
  get size(): number {
    return this.map.size
  }
}
```

```ts solution
export class LRUCache<K, V> {
  private map = new Map<K, V>()
  private capacity: number
  constructor(capacity: number) {
    this.capacity = capacity
  }
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }
  put(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
  }
  get size(): number {
    return this.map.size
  }
}
```

```ts tests
test('stores and reads values', () => {
  const c = new LRUCache<string, number>(2)
  c.put('a', 1)
  expect(c.get('a')).toBe(1)
  expect(c.get('missing')).toBeUndefined()
})
test('evicts the least recently used entry', () => {
  const c = new LRUCache<string, number>(2)
  c.put('a', 1); c.put('b', 2); c.put('c', 3)
  expect(c.get('a')).toBeUndefined()
  expect(c.get('b')).toBe(2)
  expect(c.get('c')).toBe(3)
  expect(c.size).toBe(2)
})
test('get refreshes recency', () => {
  const c = new LRUCache<string, number>(2)
  c.put('a', 1); c.put('b', 2)
  c.get('a')
  c.put('c', 3)
  expect(c.get('b')).toBeUndefined()
  expect(c.get('a')).toBe(1)
})
test('put on an existing key updates and refreshes it', () => {
  const c = new LRUCache<string, number>(2)
  c.put('a', 1); c.put('b', 2)
  c.put('a', 10)
  c.put('c', 3)
  expect(c.get('a')).toBe(10)
  expect(c.get('b')).toBeUndefined()
  expect(c.size).toBe(2)
})
test('capacity 1', () => {
  const c = new LRUCache<number, string>(1)
  c.put(1, 'one'); c.put(2, 'two')
  expect(c.get(1)).toBeUndefined()
  expect(c.get(2)).toBe('two')
})
```
:::

:::challenge id=pro-08-c3 lang=ts xp=40
title: Group anagrams
Write `groupAnagrams(words)` that groups words that are anagrams of each other
(same letters, different order). Return an array of groups. Inside each group keep the words in
their **original order**; the groups themselves come in order of **first appearance**.

```ts
groupAnagrams(['eat', 'tea', 'tan', 'ate', 'nat', 'bat'])
// → [['eat', 'tea', 'ate'], ['tan', 'nat'], ['bat']]
```

Then say the complexity out loud: with sorted keys it's O(n · k log k) for n words of length k.

hint: Two words are anagrams if their sorted letters are equal: `w.split('').sort().join('')`.
hint: Use a `Map<string, string[]>` — Maps keep insertion order, which gives you "order of first appearance" for free.

```ts starter
export function groupAnagrams(words: string[]): string[][] {
  return words.map((w) => [w])
}
```

```ts solution
export function groupAnagrams(words: string[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const w of words) {
    const key = w.split('').sort().join('')
    const group = groups.get(key)
    if (group) group.push(w)
    else groups.set(key, [w])
  }
  return [...groups.values()]
}
```

```ts tests
test('the classic example', () => {
  expect(groupAnagrams(['eat', 'tea', 'tan', 'ate', 'nat', 'bat'])).toEqual([
    ['eat', 'tea', 'ate'],
    ['tan', 'nat'],
    ['bat'],
  ])
})
test('empty input', () => {
  expect(groupAnagrams([])).toEqual([])
})
test('empty strings group together', () => {
  expect(groupAnagrams(['', 'a', ''])).toEqual([['', ''], ['a']])
})
test('duplicates stay in the same group', () => {
  expect(groupAnagrams(['ab', 'ba', 'ab'])).toEqual([['ab', 'ba', 'ab']])
})
test('same letters, different counts are not anagrams', () => {
  expect(groupAnagrams(['aab', 'abb'])).toEqual([['aab'], ['abb']])
})
```
:::

:::pro title="Complexity talk"
After every solution, state time and space complexity and one alternative. LRU with `Map`:
O(1) get/put, O(capacity) space. Group anagrams: a 26-letter count key (`"1#0#0#…"`) gives
O(n · k) instead of O(n · k log k). Debounce vs **throttle**: debounce waits for a pause;
throttle runs at most once per interval (scroll handlers).
:::

## System design in the interview

Use the structure from the System Design lesson: **requirements → estimates → high-level
diagram → data model & API → deep dives → failure modes & trade-offs**. Common prompts for
full-stack roles: URL shortener, a Trello/Jira-like board with real-time updates, a chat app,
a notification service, a file-upload/sharing service, a rate limiter, a news feed.

Follow-up questions interviewers love, and the short answer they're fishing for:

| They ask | You say |
|---|---|
| "What happens with three instances?" | Move sessions, files, locks and timers out of process (Redis, blob storage, a worker) |
| "How do you rate-limit across instances?" | Shared counter in Redis (`INCR` + `EXPIRE`) or at the gateway, returning 429 + `Retry-After` |
| "The worker queue is growing. Now what?" | Scale workers on queue length (KEDA), cap replicas by DB capacity, make handlers idempotent |
| "What if Redis goes down?" | Cache misses fall back to the DB; decide whether the limiter fails open or closed; Redis is never the source of truth |
| "How do you avoid losing the event?" | Outbox table in the same transaction, relay publishes, at-least-once delivery + idempotent consumers |

:::quiz id=pro-08-q13 xp=15
"Our API runs on 4 pods. We use ASP.NET Core's `AddRateLimiter` with a fixed window of 100
requests per minute per API key. A load test shows one key getting about 400 requests per
minute through. Why, and what would you change?"
- [ ] The fixed-window algorithm is broken; switch to a token bucket
- [x] Each pod has its own in-memory counters, so the effective limit is 4 × 100. Count in a shared store (Redis `INCR` + `EXPIRE` per key per window) or enforce it at the gateway
- [ ] The load balancer is caching responses
- [ ] Rate limiting only works for authenticated users
> The built-in limiters keep their state in process memory, which is great for protecting a single
> instance and useless as a global quota. A shared counter that every pod increments atomically
> (Redis) or a single enforcement point (API gateway) gives you one real limit. Switching
> algorithms doesn't help: a per-pod token bucket has exactly the same 4× problem. A good
> interview answer also mentions the trade-off: Redis adds a network hop per request and a
> dependency, so decide whether the limiter fails open or closed when Redis is down.
:::

:::warn title="The common mistakes"
Jumping to Kafka and microservices before asking how many users there are. Never mentioning the
database schema. Ignoring failure modes. Talking for 20 minutes without checking in with the
interviewer ("Should I go deeper on the real-time part or the data model?").
:::

## Behavioural questions and STAR

Behavioural rounds ask about the past because it predicts the future: "Tell me about a time you…".
Answer with **STAR**:

- **Situation**: the context in one or two sentences (team, product, constraint).
- **Task**: what *you* were responsible for.
- **Action**: what *you* did — the biggest part. Say "I", not "we". Include your reasoning.
- **Result**: the outcome, with numbers if possible, and what you learned.

Example — "Tell me about a production incident":

> **S:** At my last job our checkout API started timing out on Black Friday morning.
> **T:** I was on call and owned getting it back up.
> **A:** I checked the dashboards, saw database CPU at 100 %, and found via `pg_stat_statements`
> a new report query doing a sequential scan. I disabled the report with its feature flag,
> which brought latency back within ten minutes, then added a composite index and re-enabled it
> that afternoon. I wrote the postmortem and proposed a CI check that runs `EXPLAIN` on new
> queries against production-sized data.
> **R:** Downtime was 14 minutes; the CI check caught two similar issues the next quarter.

Prepare **6–8 stories** that you can adapt: a conflict with a colleague, a mistake you made, a
tight deadline, a technical decision you drove, mentoring or helping someone, a time you
disagreed with a manager, a project you're proud of, an ambiguous problem you clarified.

:::job title="Questions to ask them"
Always have questions ready — it's part of the evaluation and protects you from a bad job.
"How does code get from a PR to production?" "What does on-call look like?" "How are
priorities decided?" "What would make someone successful here in the first 90 days?"
"What's the biggest technical challenge right now?"
:::

:::lab id=pro-08-lab1 xp=100
title: Build your interview kit
Prepare the material you'll reuse in every interview. Keep it in one document.

1. Write **six STAR stories** (conflict, failure/mistake, deadline, technical decision,
   helping someone, proudest project). Each fits in ~2 minutes when spoken.
2. Write a **90-second "tell me about yourself"**: present → past → why this role.
3. Pick one project you know deeply and prepare to **draw its architecture** and explain one hard
   bug you fixed in it.
4. Do one **timed mock**: 45 minutes, one of the coding challenges above from scratch (no hints),
   explaining out loud — record yourself or ask a friend.
5. Do one **mock system design** (e.g. a chat app with SignalR) in 45 minutes on a whiteboard tool.
6. Write down **five questions** you'll ask the company.

:::tip
Read your stories out loud. If one takes more than 3 minutes, cut the Situation part — that's
almost always where the waste is.
:::

- [ ] I have six written STAR stories with a measurable Result where possible
- [ ] I can deliver my "tell me about yourself" in under 90 seconds
- [ ] I can draw one project's architecture from memory and explain one hard bug I fixed in it
- [ ] I solved debounce, LRU cache and group anagrams from scratch, talking out loud, and stated their complexity
- [ ] I completed one timed mock system design
- [ ] I have five questions prepared for the interviewers
:::

## Flashcard decks

:::cards id=pro-08-cards1 xp=20 title="JavaScript & TypeScript"
Q: What is a closure?
A: A function together with the variables from the scope where it was created. It keeps access to them after that scope has returned (used for private state, callbacks, hooks).
Q: Explain the event loop order.
A: Run synchronous code; then drain all microtasks (promise callbacks, code after await, queueMicrotask); then one macrotask (setTimeout, I/O); drain microtasks again; render; repeat.
Q: `==` vs `===`?
A: `===` compares without type coercion. `==` coerces (`0 == ''` is true). Use `===`; `x == null` is the one common exception (matches null and undefined).
Q: How is `this` determined?
A: By how a function is called: obj.method() → obj; plain call → undefined (strict mode); new → the new object; call/apply/bind set it explicitly. Arrow functions don't have their own `this` — they use the enclosing one.
Q: `let` / `const` / `var`?
A: var is function-scoped and hoisted (initialised to undefined). let/const are block-scoped with a temporal dead zone. const prevents reassignment, not mutation.
Q: Promise.all vs allSettled vs race vs any?
A: all: all fulfil, rejects on first rejection. allSettled: waits for all, never rejects. race: first to settle. any: first to fulfil, rejects only if all reject.
Q: Is a spread copy deep?
A: No, shallow: `{ ...obj }` copies top-level properties; nested objects are shared. Use structuredClone for a deep copy.
Q: `unknown` vs `any`?
A: any turns type checking off. unknown accepts anything but must be narrowed (typeof, instanceof, type guards, schema validation) before use. Prefer unknown for external data.
Q: `type` vs `interface`?
A: Both describe object shapes. Interfaces can be merged/extended with `extends` and are slightly better for public object APIs; types can express unions, intersections, mapped and conditional types. Teams pick a convention.
Q: What is structural typing?
A: TypeScript compares types by shape, not by name. Any object with the required properties is assignable, even if it was never declared to implement the type.
Q: What is a discriminated union?
A: A union of object types sharing a literal tag, e.g. `{ status: 'ok'; data } | { status: 'error'; error }`. Checking the tag narrows the type; a `never` check makes switches exhaustive.
Q: Name four utility types.
A: Partial<T>, Required<T>, Pick<T, K>, Omit<T, K>, Record<K, V>, ReturnType<F>, Awaited<T>, NonNullable<T>.
Q: What do generics give you?
A: Reusable, type-safe code where the type is a parameter: `function first<T>(xs: T[]): T | undefined`. Constraints with `extends` (`<T extends { id: string }>`).
Q: Debounce vs throttle?
A: Debounce: run after the calls stop for N ms (search input). Throttle: run at most once per N ms during continuous calls (scroll, resize).
:::

:::cards id=pro-08-cards2 xp=20 title="React"
Q: What triggers a re-render?
A: A state change in the component, a parent re-render (unless memoised and props are equal), or a change in a context it consumes.
Q: Why do list items need keys?
A: So React can match items between renders. Stable unique keys (ids) preserve state and DOM; index keys break when items are reordered, inserted or removed.
Q: Rules of hooks?
A: Call hooks only at the top level of components or custom hooks — never in conditions, loops or after early returns — so the call order is identical on every render.
Q: What is a stale closure in React?
A: A callback or effect that captured old state/props from an earlier render. Fix with correct dependencies, the updater form setX(prev => …), or a ref.
Q: Why does my effect run twice in development?
A: Strict Mode mounts, unmounts and remounts components to reveal missing cleanup. Production runs it once. Write effects that clean up properly.
Q: When do you NOT need useEffect?
A: For values derivable from props/state (compute during render), for handling user events (do it in the handler), and for resetting state on prop change (use a key).
Q: Controlled vs uncontrolled inputs?
A: Controlled: value comes from state and onChange updates it. Uncontrolled: the DOM holds the value; read it via a ref or FormData (React 19 form actions make this natural).
Q: useMemo vs useCallback vs memo?
A: useMemo caches a value, useCallback caches a function, memo skips re-rendering a component when props are shallowly equal. The React Compiler can add these automatically.
Q: Context — when and what's the cost?
A: For app-wide values (theme, current user, locale). Every consumer re-renders when the value changes, so split contexts or use a store (Zustand) for fast-changing state.
Q: Server state vs client state?
A: Server state (fetched data) needs caching, deduplication, refetching and invalidation — use TanStack Query. Client state (UI toggles, form drafts) lives in useState/useReducer/stores.
Q: What are React 19 Actions?
A: Async functions passed to form action / startTransition. React tracks pending state, errors and optimistic updates (useActionState, useFormStatus, useOptimistic).
Q: How do you speed up a slow React app?
A: Measure with the React DevTools Profiler first; then avoid unnecessary renders (state placement, memo), virtualise long lists, code-split routes with lazy(), and move heavy work off the render path.
Q: How do you test React components?
A: Vitest + React Testing Library: render, query by role/label like a user would, interact with user-event, assert on visible output. Playwright for end-to-end flows. Mock the network with MSW.
:::

:::cards id=pro-08-cards3 xp=20 title="C# & ASP.NET Core"
Q: class vs struct vs record?
A: class: reference type. struct: value type, copied on assignment, good for small immutable data. record (class or struct): value-based equality, `with` expressions, concise immutable DTOs.
Q: DI lifetimes?
A: Singleton: one per app. Scoped: one per request (DbContext). Transient: new every resolve. Never inject a shorter-lived service into a longer-lived one (captive dependency).
Q: Why avoid `.Result` / `.Wait()` on tasks?
A: Blocks a thread (thread-pool starvation under load) and can deadlock in contexts with a synchronisation context. Use async all the way.
Q: Why avoid `async void`?
A: Exceptions can't be awaited or caught by the caller and crash the process. Only use it for event handlers; return Task otherwise.
Q: What is a CancellationToken for?
A: Cooperative cancellation: ASP.NET passes RequestAborted when the client disconnects; pass it to EF Core and HttpClient calls so abandoned work stops.
Q: IEnumerable vs IQueryable?
A: IEnumerable runs LINQ in memory (C# delegates). IQueryable builds an expression tree that a provider (EF Core) translates to SQL. Calling ToList() too early pulls everything into memory.
Q: How does the middleware pipeline work?
A: Each middleware can act before and after calling next(). Order matters: exception handling first, then HTTPS, static files, routing, CORS, authentication, authorization, endpoints.
Q: Authentication vs authorization?
A: Authentication: who are you (cookie/JWT validation → ClaimsPrincipal). Authorization: what may you do (policies, roles, resource checks like "owns this project").
Q: What is the N+1 problem in EF Core and the fixes?
A: Loading a list then lazily querying each item's related data = N extra queries. Fix with projection (Select into DTOs), Include, or split queries; watch the SQL logs.
Q: AsNoTracking — when?
A: For read-only queries: EF doesn't snapshot entities in the change tracker, so it's faster and uses less memory.
Q: How do you handle concurrent updates in EF Core?
A: A concurrency token (row version / Postgres xmin). SaveChanges throws DbUpdateConcurrencyException if the row changed; return 409 Conflict.
Q: Options pattern?
A: Bind configuration sections to typed classes: `services.Configure<SmtpOptions>(config.GetSection("Smtp"))`, inject IOptions<T> / IOptionsSnapshot<T> / IOptionsMonitor<T>.
Q: Minimal APIs vs controllers?
A: Both are first-class. Minimal APIs: less ceremony, endpoint groups, filters, great for small/medium services. Controllers: attribute routing, model binding conventions, familiar in older codebases.
Q: How do you return errors in ASP.NET Core APIs?
A: ProblemDetails (RFC 9457) with AddProblemDetails() and a global exception handler; validation errors as 400 ValidationProblem; never leak stack traces in production.
Q: What does `IHttpClientFactory` solve?
A: Socket exhaustion from creating HttpClient per call and stale DNS from one static client. It pools handlers, and plugs in resilience (retries, timeouts, circuit breakers).
:::

:::cards id=pro-08-cards4 xp=20 title="SQL, HTTP & REST"
Q: INNER vs LEFT JOIN?
A: INNER keeps only matching rows. LEFT keeps every left row and fills NULLs where nothing matches. Filtering the right table in WHERE turns a LEFT into an INNER join.
Q: WHERE vs HAVING?
A: WHERE filters rows before grouping; HAVING filters groups after aggregation (HAVING COUNT(*) > 5).
Q: What are window functions?
A: Aggregates over a set of rows related to the current row without collapsing them: ROW_NUMBER() OVER (PARTITION BY customer ORDER BY created_at DESC) for "latest order per customer", running totals, ranking.
Q: Why is NOT IN dangerous?
A: If the subquery returns any NULL, NOT IN matches nothing. Use NOT EXISTS.
Q: Composite index (a, b) — which queries use it?
A: Filters on a, or on a and b (leftmost prefix). A filter on b alone usually can't use it well. PostgreSQL 18's B-tree skip scan helps when a has only a few distinct values, but don't design around it. Put equality columns first and range columns last; tenant_id first in multi-tenant apps.
Q: Why might Postgres ignore your index?
A: Low selectivity (most rows match), a function or cast on the column, a type mismatch, leading wildcard LIKE '%x', outdated statistics, or a small table where a seq scan is cheaper.
Q: ACID?
A: Atomicity (all or nothing), Consistency (constraints hold), Isolation (concurrent transactions don't interfere, per isolation level), Durability (committed data survives crashes).
Q: Postgres default isolation level and a typical anomaly?
A: READ COMMITTED. Lost updates when two transactions read-modify-write; prevent with SELECT … FOR UPDATE, atomic UPDATE … SET x = x + 1, optimistic concurrency, or SERIALIZABLE.
Q: Offset vs keyset pagination?
A: OFFSET 100000 still scans and discards 100k rows and shifts when data changes. Keyset (WHERE (created_at, id) < (:lastCreated, :lastId) ORDER BY … LIMIT 20) is fast and stable.
Q: Safe vs idempotent HTTP methods?
A: Safe (no state change): GET, HEAD, OPTIONS. Idempotent (repeating has the same effect): those plus PUT and DELETE. POST is neither; PATCH depends on the patch.
Q: Status codes for create, no content, validation, conflict?
A: 201 Created + Location header; 204 No Content; 400 (or 422) with ProblemDetails for validation errors; 409 Conflict for version conflicts or duplicates.
Q: 502 vs 503 vs 504?
A: 502 Bad Gateway: proxy got an invalid response from upstream. 503 Service Unavailable: overloaded or down for maintenance. 504 Gateway Timeout: upstream didn't answer in time.
Q: How do ETags work?
A: The server sends ETag: "v3". The client sends If-None-Match: "v3" and gets 304 Not Modified if unchanged (caching), or If-Match for optimistic concurrency on updates (412 if changed).
Q: Cookie flags for an auth cookie?
A: HttpOnly (no JS access, mitigates XSS token theft), Secure (HTTPS only), SameSite=Lax or Strict (CSRF protection), sensible expiry.
Q: What is CORS really?
A: A browser mechanism that lets a server declare which other origins' JavaScript may read its responses. Preflight OPTIONS for non-simple requests. Not a security boundary against non-browser clients.
Q: REST vs GraphQL vs gRPC?
A: REST: resources over HTTP, cache-friendly, simple. GraphQL: client chooses fields, one endpoint, good for varied UIs, harder caching. gRPC: binary Protobuf over HTTP/2, fast service-to-service, streaming.
:::

:::cards id=pro-08-cards5 xp=20 title="Docker & Kubernetes"
Q: Image vs container?
A: An image is a read-only, layered template. A container is a running (or stopped) instance of an image with its own writable layer.
Q: How do you make Docker builds fast?
A: Order layers from least to most frequently changing: copy *.csproj / package*.json, restore, then copy source and build. Use .dockerignore and BuildKit cache mounts.
Q: Why multi-stage builds?
A: Build with the full SDK image, then copy only the published output into a small runtime image (aspnet, nginx). Smaller, faster, fewer vulnerabilities.
Q: Volume vs bind mount?
A: Volume: managed by Docker, for persistent data (Postgres data dir). Bind mount: a host folder mapped in, for local development (live source code).
Q: How do containers in Compose talk to each other?
A: Over the Compose network, using service names as hostnames (Host=db). `ports:` only publishes to the host machine.
Q: Pod vs Deployment?
A: A Pod is one or more containers scheduled together with a shared network. A Deployment manages a ReplicaSet of identical pods: desired count, rolling updates, rollbacks.
Q: Service types?
A: ClusterIP (internal stable virtual IP + DNS name), NodePort (port on every node), LoadBalancer (cloud load balancer). Ingress / Gateway API routes HTTP(S) by host and path.
Q: ConfigMap vs Secret?
A: Both inject config as env vars or files. Secrets are for sensitive values, base64-encoded (not encrypted by default!) — enable encryption at rest or use an external secret store.
Q: Liveness vs readiness vs startup probe?
A: Liveness fails → container restarted. Readiness fails → removed from Service endpoints. Startup probe delays the others for slow-starting apps.
Q: Requests vs limits?
A: Requests are what the scheduler reserves (placement). Limits are the maximum: exceeding the memory limit gets the container OOMKilled; CPU is throttled.
Q: How does a rolling update work?
A: New pods start (maxSurge), become ready, then old pods terminate (maxUnavailable). `kubectl rollout undo` rolls back. Readiness probes make it safe.
Q: What scales pods automatically?
A: The HorizontalPodAutoscaler (CPU/memory/custom metrics). KEDA scales on events like queue length or Kafka lag, including down to zero. The Cluster Autoscaler (or Karpenter) adds nodes when pods don't fit.
Q: HPA or KEDA for a queue worker?
A: KEDA on queue length: I/O-bound workers show low CPU while the backlog grows, so a CPU-based HPA never scales them. Cap maxReplicaCount by what the database can handle.
Q: Why run containers as non-root?
A: Limits the damage if the app is compromised. .NET images ship an `app` user (USER app / $APP_UID); chiseled images are non-root by default.
Q: First commands when a pod is failing?
A: kubectl get pods, kubectl describe pod <name> (events: image pull errors, OOMKilled, probe failures), kubectl logs <name> --previous.
:::

:::cards id=pro-08-cards6 xp=15 title="Behavioural & process"
Q: What does STAR stand for?
A: Situation, Task, Action, Result. Spend most of the time on Action, say "I", and end with a measurable result and a lesson.
Q: "Tell me about a mistake you made."
A: Pick a real one with impact, own it without blaming, explain how you fixed it and what you changed so it can't happen again (a test, a check, a process).
Q: "Tell me about a conflict with a colleague."
A: Show that you sought to understand their view, focused on the problem not the person, used data or a small experiment, and reached a decision you both could commit to.
Q: "Why are you leaving your current job?"
A: Stay positive and forward-looking: what you want to learn or build next and why this role offers it. Never trash your current employer.
Q: "What's your biggest weakness?"
A: A real, non-critical weakness plus what you're actively doing about it, e.g. "I used to under-communicate progress; now I post short async updates daily."
Q: How do you answer a question you can't solve?
A: Think out loud, clarify the problem, solve a smaller version or brute force first, say what you'd look up. Interviewers grade the process.
Q: What should your "tell me about yourself" contain?
A: Present role and strengths → one or two relevant past highlights → why this role/company now. About 90 seconds.
Q: Good questions to ask the interviewer?
A: How work goes from PR to production, what on-call looks like, how priorities are set, what success looks like in 90 days, the biggest current technical challenge.
:::

## Recap

- Answer technical questions with **definition → example → trade-off**, and say "I don't know,
  here's how I'd find out" when needed.
- The classic traps: event-loop ordering, `var` closures, stale React closures, LINQ deferred
  execution, captive DI dependencies, `NOT IN` with NULLs, LEFT JOIN + WHERE, liveness vs
  readiness, `localhost` inside containers.
- Live coding: clarify, simple first, talk out loud, test edge cases, state complexity.
  Know **debounce**, **LRU cache** and **group anagrams** cold.
- System design: requirements → estimates → diagram → data → deep dives → failures.
- Prepare **6–8 STAR stories**, a 90-second intro and your own questions for the company.
- Re-flip the flashcard decks the evening before the interview.
