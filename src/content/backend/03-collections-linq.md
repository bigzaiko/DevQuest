---
id: be-03
title: Collections & LINQ
level: intermediate
minutes: 50
xp: 140
summary: List, Dictionary, HashSet, arrays and Span; IEnumerable vs IQueryable vs List; LINQ operators and the deferred-execution traps that cause real production bugs.
---

Most backend code is "take some data, filter it, reshape it, return it". In C# that's **collections**
plus **LINQ** (Language-Integrated Query). LINQ looks like JavaScript's `filter`/`map`/`reduce` — and
mostly is — but with one big twist: it's usually **lazy**. Understanding exactly *when* a query runs
is the difference between code that works and code that hammers the database with 500 queries.

## The collections you'll actually use

| Type | Think of it as | Lookup | Use for |
|---|---|---|---|
| `T[]` (array) | Fixed-size JS array | by index O(1) | Fixed data, method results, performance-sensitive code |
| `List<T>` | Growable JS array | by index O(1), search O(n) | The default "list of things" |
| `Dictionary<TKey,TValue>` | JS `Map` | by key O(1) | Lookups by id, caches, grouping results |
| `HashSet<T>` | JS `Set` | contains O(1) | Uniqueness, fast "have I seen this?" |
| `Queue<T>` / `Stack<T>` | FIFO / LIFO | — | Work queues, undo stacks, BFS/DFS |
| `IReadOnlyList<T>` / `IReadOnlyDictionary<,>` | Read-only views | — | **Return types**: callers can read but not mutate |

```csharp
var ids = new int[] { 3, 1, 2 };            // or: int[] ids = [3, 1, 2];
var names = new List<string> { "Ada" };     // or: List<string> names = ["Ada"];
names.Add("Grace");
names.Remove("Ada");
Console.WriteLine(names.Count);             // Count for lists, Length for arrays

var stock = new Dictionary<string, int>
{
    ["BOOK-1"] = 10,
    ["PEN-7"] = 0,
};
stock["MUG-3"] = 5;                         // add OR overwrite
stock.Add("BOOK-1", 3);                     // ❌ ArgumentException: key already exists

if (stock.TryGetValue("PEN-7", out var qty)) // the safe lookup — no exception, no double lookup
    Console.WriteLine(qty);

var count = stock["NOPE"];                  // ❌ KeyNotFoundException (JS Map would return undefined)
var safe = stock.GetValueOrDefault("NOPE"); // 0

var seen = new HashSet<string>();
seen.Add("a");                              // true
seen.Add("a");                              // false — already there
```

:::tip title="Choosing the right one is a performance decision"
`list.Contains(x)` inside a loop over another list is O(n·m) — fine for 10 items, a timeout for
100 000. Converting one side to a `HashSet<T>` or `Dictionary<,>` first makes it O(n + m). This exact
fix shows up in code review constantly.
:::

### Expose read-only, store mutable

```csharp
public sealed class Order
{
    private readonly List<OrderLine> _lines = [];
    public IReadOnlyList<OrderLine> Lines => _lines;      // callers can't Add/Remove

    public void AddLine(OrderLine line) { /* validate, then */ _lines.Add(line); }
}
```

If `Lines` were a public `List<OrderLine>`, anyone could bypass `AddLine` and its validation.

### Don't modify a collection while iterating it

```csharp
foreach (var item in cart)
    if (item.Quantity == 0) cart.Remove(item);   // ❌ InvalidOperationException: collection was modified

cart.RemoveAll(i => i.Quantity == 0);            // ✅
```

### `Span<T>`: slicing without allocating

Why does this exist? `"2026-11-05".Substring(0, 4)` allocates a brand-new string just so you can
parse it and throw it away. Do that for every field of every line of a big CSV and the garbage
collector gets busy. `Span<T>` and `ReadOnlySpan<T>` are **views** over contiguous memory (an array,
part of a string, a stack buffer): a pointer plus a length. Slicing a span doesn't copy anything:

```csharp
ReadOnlySpan<char> date = "2026-11-05";
int year = int.Parse(date[..4]);       // no "2026" substring allocated
int month = int.Parse(date[5..7]);
```

(`[..4]` and `[5..7]` are **ranges**: start inclusive, end exclusive — like `slice(0, 4)` in JS.
Arrays and strings convert to spans implicitly, and C# 14's "first-class spans" make the compiler
pick span-based overloads and extension methods for them automatically.)

Spans are `ref struct`s: they can only live on the stack, so you can't store them in fields of
classes, capture them in lambdas, or keep them across an `await`. You'll mostly *benefit* from spans
inside framework APIs (parsing, `System.Text.Json`, Kestrel) rather than write them daily — but when a
profiler shows a hot path allocating substrings, spans are the fix.

## `IEnumerable<T>`: the interface behind everything

Every collection above implements `IEnumerable<T>` — "something you can `foreach` over". It has
exactly one method, `GetEnumerator()`, which returns an object with `MoveNext()` and `Current`. That's
all `foreach` needs.

You can write your own lazily with `yield return` (like a JS generator function):

```csharp
static IEnumerable<int> Countdown(int from)
{
    for (var i = from; i > 0; i--)
    {
        Console.WriteLine($"producing {i}");
        yield return i;          // pause here until the caller asks for the next item
    }
}

foreach (var n in Countdown(3).Take(2))
    Console.WriteLine($"got {n}");
// producing 3, got 3, producing 2, got 2   ← "producing 1" never happens
```

## LINQ: the operators

LINQ is a set of **extension methods** on `IEnumerable<T>` (in `System.Linq`, imported implicitly).

| LINQ | JavaScript | Notes |
|---|---|---|
| `Where(x => …)` | `filter` | |
| `Select(x => …)` | `map` | `Select((x, i) => …)` gives the index |
| `SelectMany(x => x.Items)` | `flatMap` | Flattens nested collections |
| `OrderBy` / `OrderByDescending`, then `ThenBy` | `toSorted` | Stable; returns a new sequence, the source is untouched |
| `GroupBy(x => key)` | `Object.groupBy` | Returns groups with a `.Key` |
| `Any()` / `Any(pred)` / `All(pred)` | `some` / `every` | `Any()` = "is it non-empty?" |
| `Count()` / `Sum` / `Min` / `Max` / `Average` | `length`, `reduce` | |
| `First` / `FirstOrDefault` / `Single` / `SingleOrDefault` / `Last` | `find` | See below |
| `Distinct()` / `DistinctBy(x => key)` | `[...new Set()]` | |
| `Take(n)` / `Skip(n)` | `slice` | Paging: `Skip((page-1)*size).Take(size)` |
| `ToList()` / `ToArray()` / `ToDictionary(k, v)` / `ToHashSet()` | — | **Execute** the query now |
| `Aggregate(seed, (acc, x) => …)` | `reduce` | Rarely needed; prefer `Sum`, `Max`… |
| `Chunk(n)`, `MinBy` / `MaxBy` (.NET 6), `CountBy`, `AggregateBy`, `Index()` (.NET 9) | lodash | Newer additions; `Zip` pairs two sequences |
| `Join`, and in .NET 10 `LeftJoin` / `RightJoin` | — | Correlate two sequences by key |

A realistic example:

```csharp
var topCustomers = orders
    .Where(o => o.Status == OrderStatus.Paid)
    .GroupBy(o => o.CustomerId)
    .Select(g => new { CustomerId = g.Key, Spent = g.Sum(o => o.Total), Orders = g.Count() })
    .OrderByDescending(x => x.Spent)
    .Take(10)
    .ToList();

var byId = customers.ToDictionary(c => c.Id);              // Dictionary<int, Customer>
var namesByCountry = customers
    .GroupBy(c => c.Country)
    .ToDictionary(g => g.Key, g => g.Select(c => c.Name).ToList());
```

Two operators deserve a closer look because they trip people up.

**`SelectMany` flattens.** `Select(o => o.Lines)` gives you a sequence *of lists* (one list per
order). `SelectMany(o => o.Lines)` gives you one flat sequence of all lines:

```csharp
// orders: [ {Lines: [BOOK, PEN]}, {Lines: [LAPTOP]} ]
orders.Select(o => o.Lines);       // [[BOOK, PEN], [LAPTOP]]   IEnumerable<IReadOnlyList<OrderLine>>
orders.SelectMany(o => o.Lines);   // [BOOK, PEN, LAPTOP]        IEnumerable<OrderLine>
```

**Tie-breakers use `ThenBy`, not a second `OrderBy`.** `OrderBy` always sorts the *whole* sequence
again, so a second `OrderBy` becomes the **primary** sort key instead of a tie-breaker:

```csharp
people.OrderBy(p => p.LastName).OrderBy(p => p.FirstName);   // ❌ sorted by FirstName first
people.OrderBy(p => p.LastName).ThenBy(p => p.FirstName);    // ✅ LastName, then FirstName within ties
```

(In memory the sort is stable, so the first ordering survives only as a hidden tie-breaker; EF Core
simply drops the earlier `OrderBy` from the SQL. Either way, not what you meant.)

There's also **query syntax**, which compiles to the same method calls:

```csharp
var cheap = from p in products
            where p.Price < 10
            orderby p.Name
            select p.Name;
```

Most teams use method syntax; you'll see query syntax mostly for joins and multi-`from` queries,
where it reads more naturally.

### `First` vs `FirstOrDefault` vs `Single`

| Method | 0 matches | 1 match | 2+ matches |
|---|---|---|---|
| `First()` | throws | returns it | returns the first |
| `FirstOrDefault()` | `default` (`null` / `0`) | returns it | returns the first |
| `Single()` | throws | returns it | **throws** |
| `SingleOrDefault()` | `default` | returns it | **throws** |

- Use `First` when "none" would be a bug, `FirstOrDefault` when "none" is a normal outcome (then
  check for null!).
- Use `Single` when "more than one" would indicate corrupted data (e.g. a lookup by unique email).
- Beware `FirstOrDefault` on value types: `scores.FirstOrDefault(s => s > 90)` returns `0` when
  nothing matches — indistinguishable from a real score of `0`. Use `FirstOrDefault(pred, -1)` or
  check `Any` first.

## Deferred execution: when does the query run?

Most LINQ operators (`Where`, `Select`, `OrderBy`, `GroupBy`, `Take`…) **don't do anything** when you
call them. They return a query object describing the work. The work happens when someone
**enumerates** it — `foreach`, `ToList()`, `Count()`, `First()`, `Sum()`, `Any()`…

```csharp
var numbers = new List<int> { 1, 2, 3 };
var evens = numbers.Where(n => n % 2 == 0);   // nothing happens yet
numbers.Add(4);
Console.WriteLine(evens.Count());              // 2 — runs NOW and sees the 4
```

Why lazy? It lets you **compose** a query in steps (add a `Where` only if a filter was supplied,
then sort, then page) without doing any work until the end — and it lets EF Core turn the whole chain
into **one** SQL statement. The price is that you have to know when it runs.

Two consequences you must internalise:

**1. The query re-runs every time you enumerate it.**

```csharp
var expensive = orders.Select(o => CalculateTaxRemotely(o));   // lazy
var total = expensive.Sum(t => t.Amount);    // calls CalculateTaxRemotely N times
var max = expensive.Max(t => t.Amount);      // ... and N times AGAIN
```

Fix: materialise once with `ToList()` when you'll use the result more than once.

**2. Exceptions and side effects happen later than you think** — at enumeration time, possibly after
the data source (like a `DbContext` or a file) has already been disposed:

```csharp
IEnumerable<string> ReadLines()
{
    using var reader = new StreamReader("data.csv");
    return reader.ReadToEnd().Split('\n').Where(l => l.Length > 0);   // fine: ReadToEnd ran already
}

IEnumerable<Order> LoadOrders()
{
    using var db = new ShopDbContext();
    return db.Orders.Where(o => o.Total > 100);   // ❌ query runs later, after db is disposed
}                                                 //    → ObjectDisposedException in the caller
```

Fix: materialise (`ToList()`) **before** the resource goes away, and return `IReadOnlyList<T>`.

:::warn title="Analyzer warning CA1851 / 'possible multiple enumeration'"
Rider warns about multiple enumeration of an `IEnumerable<T>` out of the box; the .NET analyzer rule
CA1851 does the same but is off by default (enable it in `.editorconfig`). Take the warning
seriously when the source might be a database query, an HTTP stream or a `yield` method. A common
team rule: **methods accept `IEnumerable<T>` but return `IReadOnlyList<T>`** (already materialised).
:::

## `IEnumerable` vs `IQueryable` vs `List`

This distinction matters enormously once EF Core (be-10) is involved:

- **`List<T>`** — data **already in memory**. Enumerating is free.
- **`IEnumerable<T>`** — a sequence processed **in memory, in C#**. LINQ methods take `Func<T,bool>`
  delegates: compiled C# code.
- **`IQueryable<T>`** — a query that a **provider translates** into something else (SQL for EF Core).
  LINQ methods take `Expression<Func<T,bool>>`: an **expression tree**, a data structure describing
  the lambda (`o.Total > 100` becomes "a `>` node whose left side is property `Total` and right side is
  constant `100`") instead of compiled code. EF Core walks that tree and turns it into a `WHERE` clause.

The same lambda `o => o.Total > 100` compiles to *either* form — the compiler picks based on the
parameter type of the method you're calling. That's why the next bug is so easy to write.

```csharp
// db.Orders is IQueryable<Order>
var big = await db.Orders
    .Where(o => o.Total > 100)          // becomes SQL WHERE "Total" > 100
    .OrderBy(o => o.CreatedAt)
    .Take(20)                           // becomes LIMIT 20
    .ToListAsync();                     // ONE SQL query, 20 rows transferred
```

Now the classic bug:

```csharp
IEnumerable<Order> orders = db.Orders;               // ⚠ static type is now IEnumerable
var big = orders.Where(o => o.Total > 100).ToList(); // SELECT * FROM orders — ALL rows! — then filters in C#
```

Because the variable's **static type** is `IEnumerable<Order>`, the compiler picks
`Enumerable.Where` (in-memory) instead of `Queryable.Where` (SQL). The code is correct, the tests pass
on 10 rows of seed data, and production falls over with 10 million rows. The same happens if a
repository method returns `IEnumerable<T>` and the caller filters it.

:::job title="What reviewers look for in LINQ over EF Core"
- Filtering, sorting and paging happen **before** `ToList()` / `ToListAsync()`, on `IQueryable`.
- No `.ToList()` in the middle of a query "to make it work" — that silently loads the whole table.
- Project with `Select` into a DTO so only needed columns are fetched.
- `Any()` instead of `Count() > 0` (stops at the first row: `EXISTS` in SQL).
:::

:::pro title="How seniors write LINQ"
- **Readability first.** A 4-step LINQ chain beats a nested loop; a 15-step chain with three
  `GroupBy`s beats nobody. Split it into well-named variables or a helper method.
- **Materialise at the edge, on purpose.** Decide *where* the query runs (usually one `ToListAsync()`
  at the end of a repository/handler method) and return `IReadOnlyList<T>` from there.
- **Know the cost in hot paths.** LINQ to Objects allocates enumerators and delegates. It's fine for
  almost all business code (and got much faster in .NET 9/10); in a measured hot loop a plain `for`
  over a `Span<T>` or array can still win. Measure before rewriting.
- **Don't hide side effects in lambdas.** `Select(x => { db.Save(x); return x; })` runs zero, one or
  many times depending on who enumerates it. Use `foreach` for side effects.
:::

## Check yourself

:::quiz id=be-03-q1
What does this print?

```csharp
var numbers = new List<int> { 1, 2, 3 };
var evens = numbers.Where(n => n % 2 == 0);
numbers.Add(4);
Console.WriteLine(evens.Count());
```

- [ ] `1`
- [x] `2`
- [ ] `4`
- [ ] It throws: the list was modified
> `Where` is **deferred**: it only stores the filter. `Count()` enumerates the list *at that moment*, which now contains 1, 2, 3, 4 → two even numbers. `1` would be right only if `Where` ran eagerly like JS `filter`. It doesn't throw, because modifying a list is only a problem *during* an enumeration — and `Add` happened before `Count()` started.
:::

:::quiz id=be-03-q2
What does this print?

```csharp
var calls = 0;
var doubled = new[] { 1, 2, 3 }.Select(x => { calls++; return x * 2; });
var sum = doubled.Sum();
var max = doubled.Max();
Console.WriteLine(calls);
```

- [ ] `3`
- [x] `6`
- [ ] `0`
- [ ] `1`
> Each enumeration re-runs the `Select` lambda: 3 calls for `Sum`, 3 more for `Max`. `3` assumes the results are cached — `IEnumerable` never caches. `0` would be true only if nothing enumerated the query, but `Sum` and `Max` both do. Imagine the lambda calls an API or the database. Fix: `var doubled = ....ToList();`, then `calls` is `3`.
:::

:::quiz id=be-03-q3
`scores` is an **empty** `List<int>`. What's the bug?

```csharp
var topScore = scores.FirstOrDefault(s => s > 90);
if (topScore != null) Console.WriteLine($"Someone scored {topScore}!");
```

- [ ] `FirstOrDefault` throws on an empty list
- [x] For `int`, "default" is `0`, not `null`; the `!= null` check is always true and prints `Someone scored 0!`
- [ ] Nothing — it prints nothing
- [ ] It doesn't compile
> `FirstOrDefault` never throws on empty input — that's what the `OrDefault` is for — and `default(int)` is `0`. Comparing an `int` with `null` compiles (lifted to `int?`) but is always true — the compiler even warns (CS0472) — so it prints `Someone scored 0!`. Use `scores.Any(s => s > 90)` or `FirstOrDefault(s => s > 90, -1)`.
:::

:::quiz id=be-03-q4
You look up a user by email, which **must** be unique. Two rows accidentally share an email. Which call surfaces that data bug instead of hiding it?

- [ ] `users.First(u => u.Email == email)`
- [ ] `users.FirstOrDefault(u => u.Email == email)`
- [x] `users.SingleOrDefault(u => u.Email == email)`
- [ ] `users.Where(u => u.Email == email).Take(1)`
> `Single`/`SingleOrDefault` throw `InvalidOperationException` when more than one element matches. `First*` and `Take(1)` silently pick one, so you'd log in as the "wrong" duplicate and never find out. (Over EF Core, `SingleOrDefault` asks for `LIMIT 2` so it can detect the duplicate. The real fix is a unique index in the database — be-10.)
:::

:::quiz id=be-03-q5
`db.Orders` is an EF Core `DbSet<Order>` (an `IQueryable<Order>`) with 5 million rows. Which version sends the filter to PostgreSQL?

```csharp
// A
IEnumerable<Order> source = db.Orders;
var a = source.Where(o => o.CustomerId == 42).ToList();

// B
IQueryable<Order> source2 = db.Orders;
var b = source2.Where(o => o.CustomerId == 42).ToList();

// C
var c = db.Orders.ToList().Where(o => o.CustomerId == 42).ToList();
```

- [ ] A and B
- [x] Only B
- [ ] A, B and C — EF Core always translates `Where`
- [ ] Only C
> Overload resolution uses the **static** type. In A it's `IEnumerable`, so `Enumerable.Where` runs in memory after loading every row. In C, `ToList()` loads every row first. Only B stays `IQueryable`, so `Queryable.Where` is translated to `WHERE "CustomerId" = 42`.
:::

:::quiz id=be-03-q6
Which lines throw an exception? (select all)

```csharp
var stock = new Dictionary<string, int> { ["BOOK"] = 1 };
stock["BOOK"] = 5;                    // A
stock.Add("BOOK", 7);                 // B
var x = stock["PEN"];                 // C
var y = stock.GetValueOrDefault("PEN"); // D
```

- [ ] A
- [x] B
- [x] C
- [ ] D
> The indexer setter (A) adds **or overwrites**. `Add` (B) throws `ArgumentException` for an existing key. The indexer getter (C) throws `KeyNotFoundException` for a missing key. `GetValueOrDefault` (D) returns `0`. Prefer `TryGetValue` when a key may be missing.
:::

:::quiz id=be-03-q7
What does this print?

```csharp
var words = new[] { "apple", "avocado", "banana", "blueberry", "cherry" };
var result = words
    .GroupBy(w => w[0])
    .Where(g => g.Count() > 1)
    .Select(g => $"{g.Key}:{g.Count()}");
Console.WriteLine(string.Join(" ", result));
```

- [x] `a:2 b:2`
- [ ] `a:2 b:2 c:1`
- [ ] `apple avocado banana blueberry`
- [ ] `2 2`
> `GroupBy` groups by first letter (`a`, `b`, `c`) and keeps groups in first-seen order; `Where` then drops the `c` group because it has a single word, so `c:1` is not printed. Each group is itself a sequence with a `.Key`, and the `Select` turns it into a string like `a:2`.
:::

:::quiz id=be-03-q8
Your method signature is `public IEnumerable<Product> GetFeatured()`, implemented with `yield return` over a database reader. What's the best advice for callers who use the result three times?

- [ ] Nothing — `IEnumerable` caches results automatically
- [x] Materialise once (`var featured = GetFeatured().ToList();`) — otherwise the query runs three times
- [ ] Call `GetFeatured()` three times for fresh data
- [ ] Wrap it in `try/catch`
> An `IEnumerable<T>` makes no caching promise — so "it caches automatically" is wrong. A `yield` method re-executes from the start on every enumeration: three uses = three database round trips (and with a single-use reader, the second one may fail outright). Better still, change the method to return `IReadOnlyList<Product>` so it's materialised once and callers can't get it wrong.
:::

:::quiz id=be-03-q9
Spot the bug. The goal is "most expensive first; equal prices in alphabetical order".

```csharp
var sorted = products
    .OrderByDescending(p => p.Price)
    .OrderBy(p => p.Name)
    .ToList();
```

- [ ] Nothing — the two sorts combine into "price, then name"
- [x] The second `OrderBy` becomes the primary sort, so the list ends up alphabetical; it should be `.ThenBy(p => p.Name)`
- [ ] `OrderByDescending` can't be followed by an ascending sort
- [ ] It sorts correctly but runs the sort twice, so it's only a performance issue
> Every `OrderBy` sorts the entire sequence again by its key, so the *last* `OrderBy` wins as the primary key: you get A→Z by name, with price only deciding between products that share a name. `ThenBy` / `ThenByDescending` are the tie-breakers that refine an existing order. Mixing directions is perfectly legal: `.OrderByDescending(p => p.Price).ThenBy(p => p.Name)`.
:::

:::quiz id=be-03-q10
What is the type and content of `skus`?

```csharp
var orders = new[]
{
    new { Id = 1, Skus = new[] { "BOOK", "PEN" } },
    new { Id = 2, Skus = new[] { "BOOK" } },
};
var skus = orders.SelectMany(o => o.Skus).Distinct().ToList();
```

- [ ] `List<string[]>` with two arrays
- [x] `List<string>` with `BOOK`, `PEN`
- [ ] `List<string>` with `BOOK`, `PEN`, `BOOK`
- [ ] `List<string>` with `BOOK`
> `SelectMany` flattens the per-order arrays into one sequence (`BOOK, PEN, BOOK`) — that's the difference from `Select`, which would give `List<string[]>`. `Distinct` then removes the duplicate `BOOK` (LINQ to Objects keeps first-seen order): `BOOK, PEN`.
:::

## Challenge: build `groupBy` yourself

LINQ isn't magic — it's ordinary code. Writing `GroupBy` in TypeScript is the fastest way to understand
what it returns: an ordered collection of `(key, items)` groups. Your version returns a `Map`, which
(like LINQ) keeps keys in **first-seen order**.

:::challenge id=be-03-c1 lang=ts xp=40
title: LINQ-style groupBy and countBy
Implement:

- `groupBy(items, keySelector)` → `Map<K, T[]>` with keys in **first-seen order** and each group's
  items in their **original order**. Keys can be any type (strings, numbers…); an empty input gives an
  empty `Map`.
- `countBy(items, keySelector)` → `Map<K, number>` with the number of items per key, keys also in
  first-seen order (like .NET 9's `CountBy`).
- Call `keySelector` **exactly once per item** — in real code it might be expensive (the tests count
  the calls).

Don't use `Object.groupBy` / `Map.groupBy` — write the loop.

hint: Loop once. For each item compute `key = keySelector(item)`; if the map has no entry, `set(key, [])`; then push.
hint: `countBy` can reuse `groupBy`, or keep its own `Map<K, number>` with `(map.get(key) ?? 0) + 1`.

```ts starter
export function groupBy<T, K>(items: T[], keySelector: (item: T) => K): Map<K, T[]> {
  // TODO
  return new Map()
}

export function countBy<T, K>(items: T[], keySelector: (item: T) => K): Map<K, number> {
  // TODO
  return new Map()
}
```

```ts solution
export function groupBy<T, K>(items: T[], keySelector: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keySelector(item)
    let bucket = groups.get(key)
    if (!bucket) {
      bucket = []
      groups.set(key, bucket)
    }
    bucket.push(item)
  }
  return groups
}

export function countBy<T, K>(items: T[], keySelector: (item: T) => K): Map<K, number> {
  const counts = new Map<K, number>()
  for (const item of items) {
    const key = keySelector(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
```

```ts tests
const orders = [
  { id: 1, country: 'UK', total: 45 },
  { id: 2, country: 'FI', total: 900 },
  { id: 3, country: 'UK', total: 20 },
  { id: 4, country: 'US', total: 30 },
]

test('groups items by key', () => {
  const g = groupBy(orders, (o) => o.country)
  expect(g.get('UK')!.map((o) => o.id)).toEqual([1, 3])
  expect(g.get('FI')!.map((o) => o.id)).toEqual([2])
})

test('keeps keys in first-seen order', () => {
  expect([...groupBy(orders, (o) => o.country).keys()]).toEqual(['UK', 'FI', 'US'])
})

test('empty input gives an empty map', () => {
  expect(groupBy([], (x: number) => x).size).toBe(0)
})

test('works with non-string keys', () => {
  const g = groupBy([1, 2, 3, 4, 5, 6], (n) => n % 3)
  expect([...g.keys()]).toEqual([1, 2, 0])
  expect(g.get(0)).toEqual([3, 6])
})

test('countBy counts per key', () => {
  const c = countBy(orders, (o) => o.country)
  expect(c.get('UK')).toBe(2)
  expect(c.get('US')).toBe(1)
  expect([...c.keys()]).toEqual(['UK', 'FI', 'US'])
})

test('groupBy calls the key selector once per item', () => {
  const spy = fn((o: { country: string }) => o.country)
  groupBy(orders, spy)
  expect(spy).toHaveBeenCalledTimes(4)
})

test('countBy calls the key selector once per item', () => {
  const spy = fn((o: { country: string }) => o.country)
  countBy(orders, spy)
  expect(spy).toHaveBeenCalledTimes(4)
})
```
:::

## Lab: a sales report in LINQ

:::lab id=be-03-lab1 xp=90
title: Sales report kata (with xUnit)

You'll implement six report queries over in-memory orders. Tests are provided; a reference solution
is at the end — try it yourself first.

(New to `dotnet new`, `dotnet test` and `[Fact]`? The box at the start of the be-01 lab covers the minimum; be-05 and be-14 explain the CLI and xUnit in full.)

**1. Create the projects**

```bash
mkdir LinqLab && cd LinqLab
dotnet new sln -n LinqLab
dotnet new classlib -o src/LinqLab
dotnet new xunit -o tests/LinqLab.Tests
dotnet sln add src/LinqLab tests/LinqLab.Tests
dotnet add tests/LinqLab.Tests reference src/LinqLab
rm src/LinqLab/Class1.cs tests/LinqLab.Tests/UnitTest1.cs
```

**2. The model: `src/LinqLab/Orders.cs`**

```csharp
namespace LinqLab;

public enum OrderStatus { Pending, Paid, Shipped, Refunded }

public record Customer(int Id, string Name, string Country);

public record OrderLine(string Sku, int Quantity, decimal UnitPrice)
{
    public decimal Total => Quantity * UnitPrice;
}

public record Order(int Id, int CustomerId, DateOnly Date, OrderStatus Status, IReadOnlyList<OrderLine> Lines)
{
    public decimal Total => Lines.Sum(l => l.Total);
}

public record CountryRevenue(string Country, decimal Revenue, int OrderCount);
```

**3. The skeleton: `src/LinqLab/SalesReport.cs`**

```csharp
namespace LinqLab;

public sealed class SalesReport(IEnumerable<Customer> customers, IEnumerable<Order> orders)
{
    // TODO: the inputs may be lazy. Make sure each is enumerated only once (see the last test).

    /// Revenue per country from Paid + Shipped orders only, highest revenue first, ties by country name.
    public IReadOnlyList<CountryRevenue> RevenueByCountry() => throw new NotImplementedException();

    /// Names of the n customers who spent most (Paid + Shipped), ties broken by name.
    public IReadOnlyList<string> TopCustomers(int n) => throw new NotImplementedException();

    /// Distinct SKUs sold (Paid + Shipped), alphabetically.
    public IReadOnlyList<string> SkusSold() => throw new NotImplementedException();

    /// Is there at least one Refunded order?
    public bool HasRefunds() => throw new NotImplementedException();

    /// The earliest order (by Date) whose Total is above the threshold, or null.
    public Order? FirstOrderAbove(decimal threshold) => throw new NotImplementedException();

    /// Number of orders per status (statuses with zero orders may be absent).
    public Dictionary<OrderStatus, int> CountByStatus() => throw new NotImplementedException();
}
```

**4. The tests: `tests/LinqLab.Tests/SalesReportTests.cs`**

```csharp
using LinqLab;

namespace LinqLab.Tests;

public class SalesReportTests
{
    private static readonly Customer[] Customers =
    [
        new(1, "Ada", "UK"),
        new(2, "Linus", "FI"),
        new(3, "Grace", "US"),
        new(4, "Alan", "UK"),
        new(5, "Nobody", "DE"),   // never ordered
    ];

    private static readonly Order[] Orders =
    [
        new(1, 1, new DateOnly(2026, 1, 5), OrderStatus.Paid,     [new("BOOK", 2, 20m), new("PEN", 1, 5m)]), // 45
        new(2, 2, new DateOnly(2026, 1, 3), OrderStatus.Shipped,  [new("LAPTOP", 1, 900m)]),                  // 900
        new(3, 3, new DateOnly(2026, 1, 7), OrderStatus.Pending,  [new("MUG", 3, 10m)]),                      // not counted
        new(4, 4, new DateOnly(2026, 1, 1), OrderStatus.Paid,     [new("BOOK", 1, 20m)]),                     // 20
        new(5, 3, new DateOnly(2026, 1, 9), OrderStatus.Refunded, [new("PHONE", 1, 600m)]),                   // refunded
        new(6, 3, new DateOnly(2026, 1, 8), OrderStatus.Paid,     [new("CABLE", 4, 5m)]),                     // 20
    ];

    private readonly SalesReport _report = new(Customers, Orders);

    [Fact]
    public void Revenue_by_country_counts_only_paid_and_shipped()
    {
        Assert.Equal(
            [new CountryRevenue("FI", 900m, 1), new CountryRevenue("UK", 65m, 2), new CountryRevenue("US", 20m, 1)],
            _report.RevenueByCountry());
    }

    [Fact]
    public void Top_customers_are_ordered_by_spend_then_name()
    {
        Assert.Equal(["Linus", "Ada", "Alan"], _report.TopCustomers(3));
    }

    [Fact]
    public void Skus_sold_are_distinct_and_sorted()
    {
        Assert.Equal(["BOOK", "CABLE", "LAPTOP", "PEN"], _report.SkusSold());
    }

    [Fact]
    public void Detects_refunds()
    {
        Assert.True(_report.HasRefunds());
        Assert.False(new SalesReport(Customers, Orders.Where(o => o.Status != OrderStatus.Refunded)).HasRefunds());
    }

    [Fact]
    public void First_order_above_threshold_is_by_date_or_null()
    {
        Assert.Equal(2, _report.FirstOrderAbove(40m)?.Id);   // order 2 (Jan 3) beats order 1 (Jan 5)
        Assert.Null(_report.FirstOrderAbove(10_000m));
    }

    [Fact]
    public void Counts_orders_per_status()
    {
        var counts = _report.CountByStatus();

        Assert.Equal(3, counts[OrderStatus.Paid]);
        Assert.Equal(1, counts[OrderStatus.Pending]);
        Assert.Equal(1, counts[OrderStatus.Refunded]);
    }

    [Fact]
    public void Report_does_not_re_enumerate_a_lazy_source()
    {
        var enumerations = 0;
        IEnumerable<Order> Lazy()
        {
            enumerations++;
            foreach (var o in Orders) yield return o;
        }

        var report = new SalesReport(Customers, Lazy());
        report.RevenueByCountry();
        report.TopCustomers(2);
        report.HasRefunds();

        Assert.Equal(1, enumerations);
    }
}
```

**5. Run `dotnet test`** — everything fails with `NotImplementedException`. Make the tests go green
one at a time (`dotnet test --filter Detects_refunds` runs a single test).

:::tip title="Reference solution (try first!)"
```csharp
namespace LinqLab;

public sealed class SalesReport(IEnumerable<Customer> customers, IEnumerable<Order> orders)
{
    // Materialize once: the inputs might be lazy queries we don't want to re-run.
    private readonly List<Customer> _customers = customers.ToList();
    private readonly List<Order> _orders = orders.ToList();

    private IEnumerable<Order> CountedOrders =>
        _orders.Where(o => o.Status is OrderStatus.Paid or OrderStatus.Shipped);

    public IReadOnlyList<CountryRevenue> RevenueByCountry() =>
        CountedOrders
            .Join(_customers, o => o.CustomerId, c => c.Id, (o, c) => new { c.Country, o.Total })
            .GroupBy(x => x.Country)
            .Select(g => new CountryRevenue(g.Key, g.Sum(x => x.Total), g.Count()))
            .OrderByDescending(r => r.Revenue)
            .ThenBy(r => r.Country)
            .ToList();

    public IReadOnlyList<string> TopCustomers(int n)
    {
        var spentByCustomer = CountedOrders
            .GroupBy(o => o.CustomerId)
            .ToDictionary(g => g.Key, g => g.Sum(o => o.Total));

        return _customers
            .Where(c => spentByCustomer.ContainsKey(c.Id))
            .OrderByDescending(c => spentByCustomer[c.Id])
            .ThenBy(c => c.Name)
            .Take(n)
            .Select(c => c.Name)
            .ToList();
    }

    public IReadOnlyList<string> SkusSold() =>
        CountedOrders.SelectMany(o => o.Lines).Select(l => l.Sku).Distinct().Order().ToList();

    public bool HasRefunds() => _orders.Any(o => o.Status == OrderStatus.Refunded);

    public Order? FirstOrderAbove(decimal threshold) =>
        _orders.OrderBy(o => o.Date).FirstOrDefault(o => o.Total > threshold);

    public Dictionary<OrderStatus, int> CountByStatus() =>
        _orders.CountBy(o => o.Status).ToDictionary();
}
```
:::

**6. Reflect:** `CountedOrders` is a property returning a *lazy* `IEnumerable`. Why is that fine here
but would be a problem if `_orders` were an EF Core `IQueryable` being enumerated many times?

*Answer to check yourself against:* here the lazy query re-runs over a `List` that's already in
memory, so each re-run is just a cheap loop. Over an `IQueryable`, every enumeration (`RevenueByCountry`,
`TopCustomers`, `SkusSold`…) would send a **new SQL query** to the database — and could even see
different data each time.

- [ ] All 7 tests pass
- [ ] My constructor enumerates each input exactly once (`Report_does_not_re_enumerate_a_lazy_source` is green)
- [ ] I used `ThenBy` (not a second `OrderBy`) for tie-breaking — and I know why a second `OrderBy` would be wrong
- [ ] I can explain what `SelectMany` did in `SkusSold`
:::

## Flashcards

:::cards id=be-03-cards1 title="Collections & LINQ"
Q: `List<T>` vs `HashSet<T>` for `Contains`?
A: `List.Contains` is O(n) (scans); `HashSet.Contains` is O(1) (hash lookup).
Q: Safest way to read a dictionary key that may be missing?
A: `if (dict.TryGetValue(key, out var value)) { … }` — or `GetValueOrDefault(key)`.
Q: What is deferred execution?
A: Most LINQ operators just build a query; it runs when enumerated (`foreach`, `ToList`, `Count`, `First`…) — and re-runs every time.
Q: Which LINQ calls execute immediately?
A: Anything that returns a non-sequence or materialises: `ToList`, `ToArray`, `ToDictionary`, `Count`, `Sum`, `Any`, `First*`, `Single*`, `Max`…
Q: `First` vs `Single`?
A: `First` returns the first match (throws on none). `Single` also throws when there's **more than one** match.
Q: `IEnumerable<T>` vs `IQueryable<T>`?
A: `IEnumerable` runs LINQ in memory with compiled delegates. `IQueryable` holds expression trees that a provider (EF Core) translates to SQL.
Q: Why is `IEnumerable<Order> x = db.Orders; x.Where(...)` dangerous?
A: The static type picks `Enumerable.Where`, so every row is loaded from the database and filtered in memory.
Q: `ThenBy` vs a second `OrderBy`?
A: `ThenBy` adds a tie-breaker. A second `OrderBy` re-sorts everything and becomes the primary key (EF Core drops the first one entirely).
Q: What is `Span<T>`?
A: A stack-only view over contiguous memory; slicing it doesn't allocate. Can't be stored in class fields or held across `await`.
Q: Good return type for a method that returns a materialised list?
A: `IReadOnlyList<T>` — callers can index and count but not mutate, and it's clearly not lazy.
:::

## Recap

- Pick collections by access pattern: `List` (ordered), `Dictionary` (by key), `HashSet` (uniqueness).
  Expose `IReadOnlyList`/`IReadOnlyDictionary`.
- `TryGetValue` for maybe-missing keys; never modify a collection while iterating it.
- `Span<T>` slices memory without allocating; it's stack-only.
- LINQ ≈ `filter`/`map`/`reduce`, plus `GroupBy`, `SelectMany` (flatten), `ToDictionary`, `Any`,
  `CountBy`, and .NET 10's `LeftJoin`. Tie-break sorts with `ThenBy`, never a second `OrderBy`.
- **Deferred execution:** queries run when enumerated, and re-run on every enumeration. Materialise
  once with `ToList()` when reusing results.
- `First` / `FirstOrDefault` / `Single` encode your expectations; `FirstOrDefault` on value types
  returns `0`, not `null`.
- `IQueryable` → SQL; `IEnumerable` → memory. The **static type** decides. Filter, sort and page
  before materialising.
