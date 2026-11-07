---
id: pro-04
title: Debugging Like a Pro
level: intermediate
minutes: 60
xp: 150
summary: A systematic method, browser DevTools, React DevTools, .NET debugging in VS Code and Rider, stack traces, correlation ids and git bisect.
---

Juniors and seniors write roughly the same number of bugs. The difference is how fast they find
them. Seniors don't guess harder — they follow a **method** and know their **tools**. This lesson
gives you both, for the whole stack: browser, React, ASP.NET Core and the git history.

## The method: reproduce → isolate → hypothesise → verify

Why bother with a method? Because the default human strategy — stare at the code you suspect and
change things until the symptom goes away — feels productive but has no stopping rule. You can
spend a day "fixing" the wrong place. A method turns debugging into a search problem where every
step removes possibilities.

1. **Reproduce.** Get a reliable way to trigger the bug — ideally a single command, URL or test.
   Write down exact steps, data, user, browser, environment. A bug you can't reproduce is a bug
   you can't prove you fixed. If it's intermittent, find what changes between runs (timing, data,
   order of tests, cache, time zone).
2. **Isolate.** Shrink the search space. Is it frontend or backend? (Network tab: is the
   *response* wrong, or the *rendering*?) Which commit? (`git bisect`.) Which input? (Remove half
   the data and see if it still fails.) Binary search beats reading code top to bottom.
3. **Hypothesise.** State a specific, falsifiable guess: "the date is parsed as UTC on the server
   but shown in local time". Not "something with dates".
4. **Verify.** Run an experiment that could prove the hypothesis *wrong* — a breakpoint, a log
   line, a failing unit test. If it survives, fix it. If not, you've learned something; next
   hypothesis.
5. **Lock it in.** Write a **regression test** (a test that pins down a bug that once existed, so
   it can never silently return) that fails before the fix and passes after. Then ask: where else
   could the same mistake be?

A worked example. *Bug report: "Orders placed late in the evening show up on the wrong day."*

- **Reproduce:** with the laptop's time zone set to New York (UTC−5), place an order at 23:30 on
  4 March → the list shows **5 March**. Reliable, every time.
- **Isolate:** Network tab → the API returns `"createdAt": "2026-03-05T04:30:00Z"`. That *is*
  23:30 New York time, correctly stored in UTC. So the backend is fine; the bug is in how the
  frontend turns that timestamp into a date.
- **Hypothesise:** "the formatter uses `toISOString().slice(0, 10)`, which gives the **UTC** date,
  not the user's local date". Specific and falsifiable.
- **Verify:** a breakpoint in `formatDate` shows input `04:30Z`, output `"2026-03-05"`. Confirmed.
  Fix: format in the user's zone (`toLocaleDateString()` / `Intl.DateTimeFormat`).
- **Lock it in:** a unit test with a `04:30Z` timestamp formatted for `America/New_York`.

If the breakpoint had shown the correct date, the hypothesis would be disproved — and that's still
progress, not failure: one possibility is gone, and you form the next hypothesis.

:::pro title="Habits that save hours"
- **Read the actual error message.** All of it, including the inner exception. Half of all
  debugging is reading what the computer already told you.
- **Change one thing at a time.** Five simultaneous changes = you don't know which one worked.
- **Check your assumptions explicitly.** "That function is definitely called" — is it? Prove it.
- **Rubber-duck it.** Explaining the problem out loud (to a colleague, a duck, a chat message
  you never send) forces you to state assumptions — and often reveals the wrong one.
- **Timebox.** Stuck for 30–60 minutes with no new information? Ask for help, with your notes.
:::

:::quiz id=pro-04-q1 xp=10
A customer reports "the order total is wrong sometimes". What is the best **first** step?
- [ ] Rewrite the total calculation more cleanly — it's probably somewhere in there
- [ ] Add `console.log` to every function involved in checkout
- [x] Get a concrete failing example (which order, which items, expected vs actual) and reproduce it
- [ ] Deploy a hotfix that rounds totals to two decimals
> Without a reproduction you can't isolate, can't verify a hypothesis and can't prove the fix. Ask for the order id, look at its data, and turn it into a failing test. Rewriting or hot-fixing is tempting because it *feels* like action, but you'd be guessing: if the real cause is, say, a discount applied twice, rounding won't fix it and you can't tell whether your rewrite did. Logging everything comes later, once you know where to look.
:::

## Browser DevTools

Open with `F12` / `Ctrl+Shift+I` / `⌘⌥I`. The four panels you'll live in:

### Network — is it the frontend or the backend?

- Filter **Fetch/XHR** to see only API calls. Click one → **Headers** (URL, method, status,
  request headers like `Authorization`), **Payload** (what you sent), **Response** (what came
  back), **Timing**.
- Status codes tell you where to look: `4xx` = the server rejected the request (`400` bad input,
  `401` not logged in, `403` not allowed, `404` wrong URL or id), `5xx` = the server broke (go read
  the server logs), `(failed)` / `CORS error` = the browser never got a usable response (CORS,
  DNS, the API isn't running). For CORS errors, the **Console** shows the precise reason.
- **Preserve log** keeps requests across page reloads and redirects (login flows!).
- **Disable cache** while DevTools is open avoids "but I changed it" confusion.
- Right-click → **Copy as cURL** and replay the request in a terminal — now you can debug the API
  without the UI.
- **Throttling** (Fast 4G / Slow 4G) reveals race conditions and missing loading states.

### Console

```ts
console.log('user', user)               // logs a live reference — expand later shows *current* state!
console.log(JSON.stringify(user))       // snapshot at this moment
console.log(structuredClone(user))      // snapshot you can still expand
console.table(orders)                   // arrays of objects as a table
console.trace('who called me?')         // prints the call stack
console.time('render'); /* … */ console.timeEnd('render')
```

The first line is a classic trap. The console stores a *reference* to the object and only reads
its properties when you click the ▶ to expand it. If your code mutated `user` in between, you see
the new values and conclude the old line "already had" them. When an object "seems to change by
itself" in the console, take a snapshot.

`$0` in the console is the element currently selected in the Elements panel; `$_` is the last
result. **Uncaught errors** show here with a clickable stack trace.

### Sources — breakpoints instead of `console.log`

- Click a line number to set a **breakpoint**; reload or trigger the action; execution pauses.
  Hover variables, inspect **Scope**, the **Call Stack**, and step:
  **Step over** (`F10`), **Step into** (`F11`), **Step out** (`Shift+F11`), **Resume** (`F8`).
- Right-click a line number → **Conditional breakpoint** (`order.id === 42`) or **Logpoint**
  (logs a message without editing code — perfect when the bug only shows on the 500th iteration).
- Write `debugger;` in your code to break there whenever DevTools is open.
- **Pause on uncaught exceptions** / **Pause on caught exceptions** (checkboxes in the
  Breakpoints pane) break right where an error is thrown — the caught variant is how you find
  errors that a `try/catch` or a promise `.catch` silently swallows.
- **XHR/fetch breakpoints** pause when a URL containing a string is requested; **event listener
  breakpoints** pause on `click`, `submit`, etc.
- Vite serves **source maps**, so you debug your original `.tsx`, not the bundle. In production
  builds, upload source maps to your error tracker (Sentry etc.) rather than serving them publicly.

### Application

Inspect and edit `localStorage`, `sessionStorage`, cookies (is the auth cookie `HttpOnly`? does
it even exist?), IndexedDB and service workers. "Clear site data" is the nuclear reset button.

### React DevTools

The browser extension adds two tabs:

- **Components** — the component tree with current **props**, **state** and **hooks**. Select a
  component and edit state live. Use the "eye" icon to jump to the DOM node, the `<>` icon to view
  the source. Answers "why does this component show the wrong thing?" in seconds: is the prop wrong
  (look up the tree) or the rendering logic (look at this component)?
- **Profiler** — record an interaction and see which components rendered, how long, and **why**
  ("hook 2 changed", "parent rendered"). The "why" only appears if you tick **"Record why each
  component rendered while profiling"** in the DevTools settings first. Enable "Highlight updates
  when components render" to see wasted re-renders flash on screen.

Since React 19.2, React also adds its own **tracks** (Scheduler, Components) to Chrome's
**Performance** panel, so you can see React's work next to network requests and long tasks in one
timeline (in development and profiling builds).

:::quiz id=pro-04-q2 xp=10
The product list shows "No products". In the Network tab, `GET /api/products` returns
`200` with a JSON array of 12 products. Where is the bug most likely?
- [ ] In the database query
- [ ] In CORS configuration
- [x] In the frontend — how the response is stored in state or rendered
- [ ] In the API's authentication
> The server returned correct data. That isolates the problem to the client: a wrong property name (`data.items` vs `data`), state not being set, a filter that removes everything… React DevTools → Components shows whether the state actually holds the 12 items. The backend options are wrong because a `200` with the right 12 items *proves* the query, auth and CORS all worked — a CORS failure would show as an error, and the JS could not even read the body.
:::

:::quiz id=pro-04-q5 xp=10
What happens here, and what do you see when you expand the logged object in the console afterwards?
```ts
const cart = { items: 1 }
console.log('before', cart)
cart.items = 5
```
- [ ] The collapsed preview and the expanded view both show `items: 1`
- [x] The preview may show `items: 1`, but the expanded view shows `items: 5`
- [ ] It throws, because `cart` is a `const`
- [ ] The log line is printed after `cart.items = 5` runs, so everything shows `5`
> The console keeps a **live reference** and reads properties when you expand, so you see the
> current value (`5`). The one-line preview is captured at log time, which is what makes this so
> confusing. `const` only stops you from re-assigning the variable, not from mutating the object.
> Use `JSON.stringify`, `structuredClone` or a breakpoint for a true snapshot.
:::

## Reading stack traces

A stack trace is a list of function calls, **most recent first**. Read it top-down for *where*
it broke, then scan for the **first frame in your own code** — library frames above it are usually
just the messenger.

```text
TypeError: Cannot read properties of undefined (reading 'name')
    at formatCustomer (src/features/orders/format.ts:14:27)
    at OrderRow (src/features/orders/OrderRow.tsx:22:18)
    at renderWithHooks (node_modules/react-dom/...)
    ...
```

Translation: in `format.ts` line 14, column 27, something was `undefined` and we read `.name` on
it — probably `order.customer.name` with `customer` missing. Ask: *why* is it undefined? (API
doesn't include it? Wrong shape? Not loaded yet?) Slapping `?.` on it hides the symptom; finding
why fixes the bug.

A .NET exception has the same structure, plus **inner exceptions** — and the inner one is usually
the real cause:

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes.
 ---> Npgsql.PostgresException (0x80004005): 23505: duplicate key value violates unique constraint "ix_users_email"
   at Npgsql.Internal.NpgsqlConnector.ReadMessageLong(...)
   ...
   --- End of inner exception stack trace ---
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(...)
   at Api.Users.RegisterUserHandler.Handle(RegisterUser cmd, CancellationToken ct) in /src/Api/Users/RegisterUser.cs:line 41
```

The outer exception says "saving failed"; the inner says *why*: a unique constraint on email
(`23505` is Postgres' `unique_violation`). Your frame is `RegisterUser.cs:line 41`. The fix is
probably to check for an existing user — or to catch this specific error and return `409 Conflict`.

:::tip
Async stack traces in .NET contain noise like `--- End of stack trace from previous location ---`
and `MoveNext()` frames. Skip them; look for `in /path/File.cs:line N`. In Release builds line
numbers appear only if the debug symbols (`.pdb` files) are available at runtime. `dotnet publish`
copies the `.pdb` next to your `.dll` by default — make sure your Dockerfile doesn't drop it — or
set `<DebugType>embedded</DebugType>` to put the symbols inside the `.dll` itself.
:::

:::quiz id=pro-04-q3 xp=10
Which frame do you look at **first** in a long stack trace?
- [ ] The very last line — it's where the program started
- [ ] The first `node_modules` / `Microsoft.*` frame, since the framework threw the exception
- [x] The topmost frame that is in your own code (after reading the error message and any inner exception)
- [ ] Any frame mentioning `MoveNext`
> The message says *what*, inner exceptions say *why*, and your topmost frame says *where your code was involved*. The framework frame is tempting because that's literally where the exception was thrown — but frameworks usually throw *because* your code passed them something bad (a null, a duplicate key). The last line is the start of the call chain (e.g. `Main` or the event loop), the furthest point from the problem.
:::

## Debugging .NET in VS Code and Rider

Breakpoints in the backend work exactly like in the browser.

**VS Code (C# Dev Kit):** open the folder, press `F5`, choose **C#** and the project. It builds,
runs under the debugger and attaches. A minimal `.vscode/launch.json` if you want it explicit:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "API",
      "type": "dotnet",
      "request": "launch",
      "projectPath": "${workspaceFolder}/api/Api.Web/Api.Web.csproj"
    },
    {
      "name": "Attach to process",
      "type": "coreclr",
      "request": "attach",
      "processId": "${command:pickProcess}"
    }
  ]
}
```

`"type": "dotnet"` is the C# Dev Kit launcher (it builds the project and reads its
`launchSettings.json`); `"coreclr"` is the lower-level debugger configuration, used here to attach
to a process you pick from a list.

**Rider / Visual Studio:** pick the run configuration, click the bug icon (`Shift+F9` in Rider,
`F5` in VS). Rider's debugger shows variable values inline next to the code and lets you
**Set Next Statement** (drag the execution pointer) to re-run a few lines.

Techniques that carry over to all IDEs:

- **Conditional breakpoints** — `request.UserId == 42`. **Hit counts** — break on the 100th call.
- **Tracepoints / logpoints** — log `{order.Total}` without stopping or recompiling.
- **Exception settings** — break when a specific exception is *thrown* (e.g. `NullReferenceException`),
  not just when it's unhandled. Essential when middleware turns every exception into a 500.
- **Watch / Evaluate expression** — run `orders.Where(o => o.Total < 0).ToList()` while paused.
- **Attach to process** — attach to an already running `dotnet` process (e.g. one started by
  `dotnet watch`, or inside a container where the IDE has installed its debugger — VS Code's
  Docker/Dev Containers support and Rider both do this for you).
- **Debugging tests** — "Debug Test" above an xUnit test is the fastest reproduction loop there is.
- **Just My Code** — on by default; turn it off to step into library code when you suspect the
  framework.

:::warn
Breakpoints pause the whole request. A paused API means timeouts in the browser, retried
requests, and expired tokens — that "new bug" might just be your breakpoint. And never attach a
debugger to production; use logs, traces and dumps (`dotnet-dump`, `dotnet-trace`) instead.
:::

## Logs and correlation ids

In production you can't set breakpoints. You have **logs**, **metrics** and **traces** — and the
quality of your logs decides whether a bug takes 10 minutes or 2 days.

**Structured logging** — log a *message template* with named placeholders, and pass the values
separately. The logger keeps both: a readable message *and* each value as a searchable field, so
you can later query "all logs where `OrderId = 1043`" instead of grepping text:

```csharp
// ❌ hard to search and aggregate
logger.LogInformation("Order " + order.Id + " paid by " + user.Id);

// ✅ properties become fields in Seq / Elastic / Loki / Application Insights
logger.LogInformation("Order {OrderId} paid by {UserId} for {Amount}", order.Id, user.Id, order.Total);

// ❌ looks structured, but $"" builds the string first — the fields are lost again
logger.LogInformation($"Order {order.Id} paid by {user.Id}");
```

Placeholders are matched to arguments **by position**, not by name — `{OrderId}` gets the first
argument whatever it's called. The `$""` version is the common mistake: the code analyzer flags it
(CA2254), because every log entry becomes a unique string that can't be grouped or filtered.

**Log levels** — `Trace`/`Debug` (developer detail, usually off in prod), `Information` (business
events: order placed), `Warning` (unexpected but handled: retry succeeded), `Error` (operation
failed), `Critical` (app is going down). Never log passwords, tokens or full card numbers.

**Correlation ids** tie together every log line of one request — across the browser, the API, a
queue and a background worker. ASP.NET Core uses W3C **trace context**: an incoming `traceparent`
header (or a new one) becomes `Activity.Current.TraceId`, and the default logger and OpenTelemetry
attach it to every log entry.

```csharp
using System.Diagnostics;   // Activity — this line goes at the very top of Program.cs

// Return the trace id to the client so a user's bug report can be matched to server logs.
// (Headers must be set before the response starts, so we set them before calling next.)
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["X-Trace-Id"] = Activity.Current?.TraceId.ToString() ?? ctx.TraceIdentifier;
    await next();
});

// Add context to every log line inside a block
using (logger.BeginScope(new Dictionary<string, object> { ["OrderId"] = order.Id }))
{
    logger.LogInformation("Charging card");
    await payments.ChargeAsync(order);
    logger.LogInformation("Charged");
}
```

:::quiz id=pro-04-q6 xp=10
A teammate says "our logs are structured, but I can't filter by `OrderId` in Seq". Which line is the reason?
- [ ] `logger.LogInformation("Order {OrderId} shipped", order.Id);`
- [x] `logger.LogInformation($"Order {order.Id} shipped");`
- [ ] `logger.LogWarning("Order {OrderId} shipped late", order.Id);`
- [ ] `using (logger.BeginScope(new Dictionary<string, object> { ["OrderId"] = order.Id })) { … }`
> The `$""` version formats the string **before** the logger sees it, so there is no template and
> no `OrderId` field — just text. It's tempting because the output *looks* identical in the
> console. The other lines all produce an `OrderId` property: a template placeholder (at any log
> level) or a scope.
:::

ProblemDetails responses (`builder.Services.AddProblemDetails()`) include a `traceId` field
automatically. Show it in your frontend's error toast ("Something went wrong — reference
`4bf92f3577b34da6a3ce929d0e0e4736`"). When support forwards that screenshot, you search your log
tool for the id and see the entire request.

Note: ProblemDetails' `traceId` is the full `traceparent`-style id
(`00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00`: version, trace id, span id, flags).
The middle 32-hex part is the `TraceId` you search for in logs — and what the `X-Trace-Id` header
above returns — so have the frontend show that part.

:::job
Find out in week one: where do logs go (Seq, Kibana, Grafana/Loki, Datadog, Application Insights)?
Who gives you access? How do you search by trace id? Is there an error tracker (Sentry)? You don't
want to learn the log tool during your first incident.
:::

## git bisect — find the commit that broke it

"It worked last week." Somewhere among the 140 commits since then is the culprit. Reading all
140 diffs would take a day. `git bisect` instead **binary-searches** the history: you tell it one
commit that is *bad* and one that is *good*; it checks out the commit halfway between, you say
whether that one is good or bad, and it throws away the half that can't contain the culprit. Each
answer halves the range, so 140 commits take only ~8 steps (2⁸ = 256 ≥ 140).

```bash
git bisect start
git bisect bad                 # the current commit is broken
git bisect good v2.3.0         # this tag / commit was fine
# git checks out a commit in the middle. Test it, then:
git bisect good                # or: git bisect bad
# ... repeat until git prints "<sha> is the first bad commit"
git bisect reset               # back to where you started
```

Automate it: give bisect a command that exits `0` for good and non-zero for bad (exit `125` means
"can't test this commit, skip it"):

```bash
git bisect start HEAD v2.3.0
git bisect run npm test -- --run src/cart
# or for the backend:
git bisect run dotnet test --filter "FullyQualifiedName~CartTotals"
```

Write the failing test first (in an untracked file, so checkouts don't remove it), then let
`bisect run` find the commit while you get coffee. Small, focused commits make bisect point at a
10-line diff instead of a 2000-line "misc fixes" blob — one more reason for good commit hygiene.

:::quiz id=pro-04-q4 xp=10
There are 1000 commits between the last good release and today's broken `main`. Roughly how many
commits do you need to test with `git bisect`?
- [ ] About 500
- [ ] About 100
- [x] About 10
- [ ] 1000 — every commit once
> Binary search halves the range each step: 1000 → 500 → 250 → … → 1 takes log₂(1000) ≈ 10
> steps (2¹⁰ = 1024). "About 500" is the tempting answer if you imagine checking commits one by
> one and getting lucky halfway — that's linear search, which bisect exists to avoid.
:::

## Find the bug

Both functions below are "almost right" — the kind of code that passes a quick manual check and
fails in production. Read the tests, form a hypothesis, fix it.

:::challenge id=pro-04-c1 lang=ts xp=40
title: The missing last page
`paginate(items, page, pageSize)` should return one page plus metadata. Users report that the
first item never shows and the last page is sometimes missing. Find and fix the bugs (there are
three). The intended behaviour:

* Pages are **1-based**: page 1 is the first `pageSize` items.
* `totalPages` counts a final **partial** page too (10 items, size 3 → 4 pages); an empty list has `0` pages.
* `hasNext` is `true` only if a page after the current one exists.
* The result is `{ items, page, totalPages, hasNext }` with `page` echoed back unchanged.

hint: Page 1 should start at index 0.
hint: 10 items with page size 3 is how many pages? `10 / 3` is not an integer.
hint: On the last page (`page === totalPages`), `hasNext` must be `false` — check the comparison once pages are 1-based.

```ts starter
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const start = page * pageSize
  const totalPages = Math.floor(items.length / pageSize)
  return {
    items: items.slice(start, start + pageSize),
    page,
    totalPages,
    hasNext: page < totalPages - 1,
  }
}
```

```ts solution
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize
  const totalPages = Math.ceil(items.length / pageSize)
  return {
    items: items.slice(start, start + pageSize),
    page,
    totalPages,
    hasNext: page < totalPages,
  }
}
```

```ts tests
const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
test('page 1 starts with the first item', () => {
  expect(paginate(ten, 1, 3).items).toEqual([1, 2, 3])
})
test('last partial page is included', () => {
  const p = paginate(ten, 4, 3)
  expect(p.items).toEqual([10])
  expect(p.totalPages).toBe(4)
  expect(p.hasNext).toBe(false)
})
test('hasNext on a middle page', () => {
  expect(paginate(ten, 3, 3).hasNext).toBe(true)
})
test('exact multiple of page size', () => {
  const p = paginate([1, 2, 3, 4], 2, 2)
  expect(p.items).toEqual([3, 4])
  expect(p.totalPages).toBe(2)
  expect(p.hasNext).toBe(false)
})
test('empty list has zero pages', () => {
  expect(paginate([], 1, 10)).toEqual({ items: [], page: 1, totalPages: 0, hasNext: false })
})
```
:::

:::challenge id=pro-04-c2 lang=ts xp=40
title: The dashboard that reorders history
`latestOrders(orders, n)` returns the `n` most recent orders, newest first (by `createdAt`). It's
used on a dashboard — and since it shipped, the order history table on the same page is suddenly
sorted wrong too, and the "latest" list is occasionally out of order. Find both bugs. Requirements:

* Return at most `n` orders, newest first (all of them if `n` is larger than the list).
* **Don't change the array that was passed in** — other components share it.

hint: Which array methods **mutate** the array they are called on?
hint: A `sort` comparator must return a negative number, zero or a positive number — not a boolean. A boolean becomes `1` or `0`, so the sort never sees "a comes first" and results depend on the engine's algorithm.
hint: `[...orders].sort(…)` or `orders.toSorted(…)` sorts a copy. For newest first: `Date.parse(b.createdAt) - Date.parse(a.createdAt)`.

```ts starter
interface Order { id: number; createdAt: string } // ISO 8601 timestamps

export function latestOrders(orders: Order[], n: number): Order[] {
  return orders
    .sort((a, b) => (a.createdAt < b.createdAt) as unknown as number)
    .slice(0, n)
}
```

```ts solution
interface Order { id: number; createdAt: string } // ISO 8601 timestamps

export function latestOrders(orders: Order[], n: number): Order[] {
  return [...orders]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, n)
}
```

```ts tests
const make = () => [
  { id: 1, createdAt: '2026-03-01T10:00:00Z' },
  { id: 2, createdAt: '2026-03-05T09:00:00Z' },
  { id: 3, createdAt: '2026-02-20T12:00:00Z' },
  { id: 4, createdAt: '2026-03-04T08:30:00Z' },
  { id: 5, createdAt: '2026-01-15T00:00:00Z' },
  { id: 6, createdAt: '2026-03-05T18:00:00Z' },
  { id: 7, createdAt: '2026-02-01T07:45:00Z' },
]
test('returns the n newest, newest first', () => {
  expect(latestOrders(make(), 3).map((o) => o.id)).toEqual([6, 2, 4])
})
test('does not reorder the caller\'s array', () => {
  const orders = make()
  latestOrders(orders, 2)
  expect(orders.map((o) => o.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
})
test('n larger than the list returns everything sorted', () => {
  expect(latestOrders(make(), 50).map((o) => o.id)).toEqual([6, 2, 4, 1, 3, 7, 5])
})
```
:::

:::lab id=pro-04-lab1 xp=80
title: Bisect a regression, then debug it
**Part 1 — git bisect.** Generate a repo with 40 commits where one of them silently breaks `add`:

```bash
mkdir bisect-lab && cd bisect-lab && git init -q
echo 'export const add = (a, b) => a + b' > math.mjs
for i in $(seq 1 40); do
  echo "change $i" >> CHANGELOG.txt
  if [ "$i" -eq 27 ]; then echo 'export const add = (a, b) => a + b + (a > 1 ? 1 : 0)' > math.mjs; fi
  git add -A && git commit -qm "chore: change $i"
done
cat > check.mjs <<'EOF'
import { add } from './math.mjs'
process.exit(add(2, 2) === 4 ? 0 : 1)
EOF
```

`check.mjs` is untracked, so it stays put while bisect checks out old commits. Now find the bad
commit — first manually, then automatically:

```bash
# manual
FIRST=$(git rev-list --max-parents=0 HEAD)   # sha of the very first commit
git bisect start
git bisect bad                 # HEAD (change 40) is broken
git bisect good "$FIRST"       # change 1 was fine
node check.mjs; echo $?        # 0 → git bisect good, 1 → git bisect bad; repeat
git bisect reset

# automatic
git bisect start HEAD "$FIRST"
git bisect run node check.mjs
git bisect reset
```

Both end with output like this (your sha differs):

```text
3f9c2e1a… is the first bad commit
commit 3f9c2e1a…
Author: You <you@example.com>
Date:   …

    chore: change 27

 CHANGELOG.txt | 1 +
 math.mjs      | 2 +-
 2 files changed, 2 insertions(+), 1 deletion(-)
```

**Part 2 — debugger.** In any ASP.NET Core API (or `dotnet new webapi`), add an endpoint with a
loop over a list, set a **conditional breakpoint** that only stops on one specific item, inspect
the variables, and evaluate an expression in the Watch/Evaluate window. Then do the same in the
browser: set a breakpoint in a React event handler via DevTools → Sources.

**Part 3 — trace id.** Add the `X-Trace-Id` middleware from this lesson and an endpoint that
logs something:

```csharp
app.MapGet("/hello", (ILogger<Program> logger) =>
{
    logger.LogInformation("Saying hello");
    return "Hello";
});
```

Turn on log scopes in `appsettings.Development.json` — the trace id travels in a scope that
ASP.NET Core opens for every request:

```json
{
  "Logging": {
    "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" },
    "Console": { "FormatterOptions": { "IncludeScopes": true } }
  }
}
```

Run the API, then call the endpoint (use your port):

```bash
curl -i http://localhost:5080/hello
# HTTP/1.1 200 OK
# X-Trace-Id: 4bf92f3577b34da6a3ce929d0e0e4736
```

The console shows the same id in the scope line of your log entry:

```text
info: Program[0]
      => SpanId:00f067aa0ba902b7, TraceId:4bf92f3577b34da6a3ce929d0e0e4736, ParentId:0000000000000000 => ConnectionId:… => RequestPath:/hello RequestId:…
      Saying hello
```

- [ ] Manual bisect identified "chore: change 27" as the first bad commit
- [ ] `git bisect run node check.mjs` found the same commit automatically, and `git bisect reset` returned to `main`/`master`
- [ ] A conditional breakpoint in the .NET API stopped only for the chosen item, and I evaluated an expression while paused
- [ ] I paused a React event handler in the browser and stepped through it
- [ ] I matched an `X-Trace-Id` response header to the server's log output
:::

:::cards id=pro-04-cards1 xp=15 title="Debugging"
Q: The four steps of systematic debugging?
A: Reproduce → isolate → hypothesise → verify. Then lock it in with a regression test.
Q: How do you tell frontend from backend bugs quickly?
A: Network tab: if the response is wrong, it's the server (or the request); if the response is right, it's the client.
Q: Logpoint?
A: A breakpoint that logs a message instead of pausing — no code change, no rebuild.
Q: Why can `console.log(obj)` mislead you?
A: It logs a live reference; expanding later shows the current state, not the state at log time. Use JSON.stringify or a breakpoint.
Q: What does React DevTools' Profiler tell you?
A: Which components rendered during an interaction, how long they took and why they re-rendered.
Q: In a .NET exception, where is the real cause usually?
A: In the inner exception (`--->`), e.g. a PostgresException with an SQLSTATE code.
Q: Which stack frame do you read first?
A: The topmost one in your own code, after the message and inner exception.
Q: Exception settings / "break on thrown"?
A: Pause where an exception is thrown even if middleware catches it later — essential when every error becomes a generic 500.
Q: Structured logging?
A: Log message templates with named properties (`{OrderId}`) so logs can be filtered and aggregated by field.
Q: Why is `logger.LogInformation($"Order {id}")` a mistake?
A: The string is built before the logger sees it, so there's no template and no `OrderId` field. Use `"Order {OrderId}", id` (analyzer CA2254).
Q: What is a correlation / trace id?
A: An id shared by every log and span of one request across services (W3C `traceparent`), returned to the client so reports can be matched to logs.
Q: `git bisect run` exit codes?
A: 0 = good, 1–124/126–127 = bad, 125 = skip this commit.
Q: Why not attach a debugger in production?
A: It pauses real users' requests and is a security risk. Use logs, traces, metrics and dumps.
:::

## Recap

- Debug with a method: reproduce, isolate (binary search everything), hypothesise specifically, verify, then add a regression test.
- Network tab first: it splits frontend from backend bugs. Then Sources breakpoints, conditional breakpoints and logpoints.
- React DevTools Components shows props/state/hooks; the Profiler shows why things re-render.
- Read stack traces: message, inner exception, then the topmost frame in your code.
- Use the IDE debugger for .NET: conditional breakpoints, break on thrown exceptions, evaluate expressions, debug tests.
- In production, structured logs + correlation/trace ids are your debugger — expose the trace id to users.
- `git bisect run <test>` finds the breaking commit in log₂(n) steps.
