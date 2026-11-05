---
id: be-01
title: C# Essentials for JS/TS Developers
level: beginner
minutes: 45
xp: 120
summary: Static typing that is real at runtime, value vs reference types, nullable references, classes, records and structs — C# through the eyes of a TypeScript developer.
---

If you know TypeScript, you already know half of C#'s syntax: curly braces, `if`/`for`/`while`,
lambdas (`x => x * 2`), generics (`List<T>`), `async`/`await`, classes and interfaces. What's different
is underneath. In TypeScript, types are a **compile-time illusion** — they're erased and your code runs
as plain JavaScript. In C#, types are **real at runtime**: the compiler checks them, and the runtime
enforces them again. That one difference explains most of what follows.

## How C# runs

```text
 Program.cs ──(dotnet build / Roslyn compiler)──► MyApp.dll (IL bytecode + metadata)
                                                    │
                                    (dotnet run)    ▼
                                         .NET runtime (CLR): JIT compiles IL → machine code
```

- **Roslyn** (the C# compiler) turns your `.cs` files into **IL** (Intermediate Language) inside a `.dll`.
- The **CLR** (Common Language Runtime) loads the `.dll` and **JIT-compiles** IL to native machine code
  as methods are first called. It also runs the **garbage collector** (GC) — you never `free` memory.
- Type information survives into the `.dll`. That's why you can ask an object `obj.GetType()` at
  runtime, and why a bad cast fails loudly instead of silently producing `NaN`: `(int)"5"` is a
  **compile** error, and `object o = "5"; var n = (int)o;` throws `InvalidCastException` at runtime.
  (To turn text into a number you *parse* it: `int.Parse("5")` or `int.TryParse(...)`.)

| | TypeScript | C# |
|---|---|---|
| Types at runtime | Erased | Kept and enforced |
| `any` escape hatch | Everywhere | `object` / `dynamic` (rarely used) |
| Numbers | One `number` (64-bit float) | `int`, `long`, `double`, `decimal`, `byte`, … |
| `null` / `undefined` | Both | Only `null` |
| Equality | `===` compares references for objects | `==` compares references for classes, **values** for numbers/records/strings (plain structs have no `==` unless you define one) |
| Output | JS that a browser/Node runs | IL that the .NET runtime JITs |

:::info title="Why should a web dev care?"
Real types at runtime are what let ASP.NET Core read a JSON body straight into a typed `CreateOrder`
object, let EF Core translate `x.Price > 10` into SQL, and let the DI container build your services.
The whole framework is built on runtime type information (reflection + source generators).
:::

## Your first program: top-level statements

A modern C# console app (`dotnet new console`) is literally this:

```csharp
// Program.cs
var name = "Ada";
Console.WriteLine($"Hello, {name}!");
```

No `class Program`, no `static void Main` — those are **top-level statements** (C# 9+). The compiler
generates the `Main` method for you. Only **one** file per project may contain top-level statements,
and they must come before any type declarations in that file.

You'll still see the old style in older codebases — it means the same thing:

```csharp
namespace MyApp;

internal class Program
{
    private static void Main(string[] args)
    {
        Console.WriteLine("Hello, World!");
    }
}
```

### Namespaces and `using`

Namespaces group types, like folders for names. **File-scoped namespaces** (one line, ending in `;`)
are the modern default and save a level of indentation:

```csharp
namespace Shop.Domain;          // everything in this file is in Shop.Domain

public class Product { }
```

To use a type from another namespace, add `using` at the top (like `import`, but for a whole
namespace, not a single symbol):

```csharp
using System.Text.Json;         // now JsonSerializer is in scope

var json = JsonSerializer.Serialize(new { Id = 1 });
```

New projects enable **implicit usings** (`<ImplicitUsings>enable</ImplicitUsings>` in the `.csproj`),
so `System`, `System.Linq`, `System.Collections.Generic`, `System.Threading.Tasks` and friends are
already imported. That's why `Console` and `List<T>` work without any `using`.

## Types, `var` and numbers

```csharp
int count = 42;              // 32-bit integer
long big = 9_000_000_000L;   // 64-bit integer (underscores are just for readability)
double ratio = 0.75;         // 64-bit floating point — like JS number
decimal price = 19.99m;      // 128-bit decimal — exact base-10, use for MONEY
bool ok = true;
char letter = 'A';           // one UTF-16 code unit, single quotes (an emoji needs two!)
string text = "hello";       // double quotes; strings are immutable
```

`var` asks the compiler to **infer** the type — but the variable is still statically typed forever:

```csharp
var total = 10;      // total is int, decided at compile time
total = "ten";       // ❌ compile error CS0029: cannot convert string to int
```

`var` is not JavaScript's `let`. It's TypeScript's `const x = 10` inference — without the ability to
widen later. Teams usually use `var` when the type is obvious from the right-hand side
(`var orders = new List<Order>()`) and spell the type when it isn't.

### Two number gotchas that bite JS developers

```csharp
Console.WriteLine(7 / 2);        // 3    ← int / int = int division (truncates)
Console.WriteLine(7 / 2.0);      // 3.5  ← one double makes it floating point
Console.WriteLine(0.1 + 0.2 == 0.3);     // False (binary floating point, same as JS)
Console.WriteLine(0.1m + 0.2m == 0.3m);  // True  (decimal is exact in base 10)
```

:::job title="Money is always decimal"
In code review, `double price` for money gets flagged immediately. Use `decimal` in C# and
`numeric(12,2)` in PostgreSQL. `double` is for measurements, statistics and graphics, where tiny
rounding errors don't matter.
:::

## Value types vs reference types

This is **the** concept to get right in C#. Every type is one of two kinds:

- **Value types** — `int`, `double`, `decimal`, `bool`, `char`, `DateTime`, `Guid`, enums and every
  `struct`. The variable **contains the data itself**. Assigning or passing it **copies** the data.
- **Reference types** — `string`, arrays, `List<T>`, and every `class` and `record` (class).
  The variable contains a **reference** (pointer) to an object on the heap. Assigning or passing it
  copies the **reference**, so both variables point at the **same** object.

JavaScript has the same split — primitives are copied, objects are shared — but in C# **you choose**
which kind your own types are: `struct` (value) or `class` (reference).

```csharp
var s1 = new PointStruct { X = 1 };
var s2 = s1;          // copies the whole struct
s2.X = 99;
Console.WriteLine(s1.X);   // 1  — s1 is untouched

var c1 = new PointClass { X = 1 };
var c2 = c1;          // copies the reference — same object
c2.X = 99;
Console.WriteLine(c1.X);   // 99 — both variables see the change

// In a file with top-level statements, type declarations must come AFTER the statements.
public struct PointStruct { public int X; }
public class PointClass { public int X; }
```

The same thing happens when you pass arguments to a method. A method receiving a struct gets a copy;
a method receiving a class instance can mutate the caller's object. If you really want a method to
modify a caller's struct, you pass it with `ref`:

```csharp
static void Bump(ref PointStruct p) => p.X++;

var p = new PointStruct { X = 1 };
Bump(ref p);                 // `ref` is required at the call site too — it's explicit on purpose
Console.WriteLine(p.X);      // 2
```

:::tip title="Stack vs heap — the honest version"
You'll hear "value types live on the stack, reference types on the heap". It's a useful first
approximation (local `int`s usually are on the stack), but the real rule is about **copy semantics**,
not location: a struct field inside a class lives on the heap with that class. Think *"copied vs
shared"*, not *"stack vs heap"*.
:::

### Equality follows the same split

```csharp
var a = new PointClass { X = 1 };
var b = new PointClass { X = 1 };
Console.WriteLine(a == b);         // False — two different objects (reference equality)

string s = "hi", t = string.Concat("h", "i");
Console.WriteLine(s == t);         // True — string overrides == to compare characters
```

`string` is a reference type that *behaves* like a value: it's immutable and `==` compares contents.
Classes you write compare by reference unless you override equality — or use a **record** (below).

Plain structs are the odd one out: `s1.Equals(s2)` compares their fields using a generic runtime implementation (it boxes, and for structs
containing references falls back to reflection, so it's slow), but
`s1 == s2` **doesn't compile** (error CS0019) until you define an `==` operator yourself. A
`record struct` (below) generates both for you.

## Strings and interpolation

```csharp
var name = "Ada";
var price = 1234.5m;

var a = $"Hello {name}";                  // interpolation (like JS template literals)
var b = $"Total: {price:0.00}";           // format specifier after the colon
var c = $"{name,-10}|";                   // alignment: pad to 10 chars, left-aligned
var path = @"C:\temp\new";                // verbatim: backslashes are literal
var json = """
    { "name": "Ada", "tags": ["math"] }
    """;                                  // raw string literal (C# 11): no escaping at all
var raw = $$"""{ "name": "{{name}}" }"""; // raw + interpolation: {{ }} marks holes
```

Formatting uses the **current culture** by default. On a German machine, `$"{1234.5m:0.00}"` produces
`"1234,50"` — a classic source of bugs when building CSV, URLs or log lines. For machine-readable text,
format with `CultureInfo.InvariantCulture`:

```csharp
using System.Globalization;

var s = string.Create(CultureInfo.InvariantCulture, $"{price:0.00}");   // "1234.50" everywhere
var t = price.ToString(CultureInfo.InvariantCulture);                     // "1234.5"
```

Because strings are immutable, building a big string in a loop with `+=` creates a new string each
time. For many concatenations use `StringBuilder` (or `string.Join`).

## Nullable reference types: `?` and `!`

In C#, value types can't be null (`int x = null` doesn't compile). To allow null, use `int?`
(short for `Nullable<int>`). Reference types *can* be null at runtime — and `NullReferenceException`
used to be the most common .NET crash.

**Nullable reference types** (NRT, on by default with `<Nullable>enable</Nullable>`) let the compiler
track nullness, just like TypeScript's `strictNullChecks`:

```csharp
string name = "Ada";        // promised non-null
string? nickname = null;    // may be null — the ? is part of the type

Console.WriteLine(nickname.Length);   // ⚠ warning CS8602 (possibly null) — and it WOULD crash if run
Console.WriteLine(nickname?.Length);  // null-conditional: null instead of a crash
Console.WriteLine(nickname ?? name);  // null-coalescing: "Ada"
nickname ??= "Countess";              // assign only if currently null

if (nickname is not null)
{
    Console.WriteLine(nickname.Length);   // ✅ compiler knows it's non-null here (flow analysis)
}
```

The `!` (**null-forgiving operator**) tells the compiler "trust me, this isn't null":

```csharp
string display = nickname!;   // silences the warning — and that's ALL it does
```

`!` generates no code and no check. If `nickname` really was null, `display` is now a "non-null"
`string` holding `null`, and the crash (`NullReferenceException`) happens later — wherever someone
finally calls `display.Length`, often far from the line that caused it.

`int?` and `string?` look alike but are different mechanisms. `int?` is a real runtime type
(`Nullable<int>`, a struct with `HasValue` and `Value`). `string?` is the same runtime type as
`string`; the `?` is just an annotation for the compiler.

:::warn title="NRT warnings are not runtime checks"
Unlike `int?`, the `?` on a reference type is **only compile-time analysis** — it's closer to
TypeScript than to the rest of C#. A `string` parameter can still receive `null` from reflection, JSON
deserialization or a caller with warnings disabled. Validate input at system boundaries (HTTP, DB,
files) and trust the types inside.
:::

:::pro title="What seniors say about `!`"
Every `!` is a small lie you're asking the compiler to believe. In review you'll hear: *"Why can this
never be null? If it can't, model it so the type says so (required property, constructor parameter).
If it can, handle it."* A handful of `!` in a codebase is normal (EF Core navigation properties use
`= null!`); dozens mean the model is wrong. Many teams also add
`<WarningsAsErrors>nullable</WarningsAsErrors>` so nullable warnings break the build.
:::

## Classes and properties

```csharp
namespace Shop.Domain;

public class Customer
{
    // field: private storage, camelCase with underscore by convention
    private readonly List<string> _notes = [];

    // constructor
    public Customer(string name, string email)
    {
        Name = name;
        Email = email;
    }

    // auto-properties: the compiler generates a hidden backing field
    public string Name { get; }               // read-only after construction
    public string Email { get; set; }         // read/write
    public string? Phone { get; init; }       // settable only during object initialization
    public DateTime CreatedAt { get; } = DateTime.UtcNow;   // initializer

    // computed property (no storage)
    public string Display => $"{Name} <{Email}>";

    // method
    public void AddNote(string note) => _notes.Add(note);
}

// Usage (e.g. in Program.cs):
var c = new Customer("Ada", "ada@example.com") { Phone = "+44 20 1234" };
c.Email = "ada@lovelace.dev";   // ✅ set
c.Phone = "x";                  // ❌ CS8852: init-only, only allowed in the object initializer
```

The `{ Phone = "..." }` part after the constructor call is an **object initializer**: it runs right
after the constructor and sets properties by name — like passing an options object in JS, but checked
by the compiler.

Properties look like fields from the outside but are really methods (`get_Name()`/`set_Name()`).
That's why public data in C# is **always** a property, never a public field: you can later add
validation or make it computed without breaking callers.

**Access modifiers:** `public` (anyone), `private` (this type only — the default for members),
`protected` (this type and subclasses), `internal` (this project/assembly only — the default for
top-level types). Mark classes `sealed` when they aren't designed for inheritance.

### `required` members

`required` (C# 11) forces callers to set a property in the object initializer — a nice alternative to
long constructors:

```csharp
public class Product
{
    public required string Name { get; init; }
    public required decimal Price { get; init; }
    public string? Description { get; init; }
}

var p = new Product { Name = "Book", Price = 12.5m };   // ✅
var q = new Product { Name = "Pen" };                   // ❌ CS9035: required member 'Price' must be set
```

## Records: data with value equality

Most backend code shuffles **data** around: DTOs, messages, query results. For that, C# has
**records** — a class (or struct) where the compiler generates value equality, `ToString()`,
deconstruction and non-destructive mutation (`with`):

```csharp
var a1 = new Address("1 Main St", "London", "UK");
var a2 = new Address("1 Main St", "London", "UK");

Console.WriteLine(a1 == a2);     // True  — compared by VALUE, not reference
Console.WriteLine(a1);           // Address { Street = 1 Main St, City = London, Country = UK }

var moved = a1 with { City = "Leeds" };   // copy with one property changed; a1 is unchanged
var (street, city, _) = moved;            // deconstruction

public record Address(string Street, string City, string Country);   // a "positional" record
```

A positional record's properties are `init`-only, so records are immutable by default — the C#
equivalent of `Readonly<{...}>` objects you'd spread to update in React state (`with` is C#'s
`{ ...a1, city: "Leeds" }`). One exception: a plain `record struct` gets `get; set;` properties;
write `readonly record struct` to keep it immutable.

:::warn title="Immutable is shallow"
`record Cart(List<string> Items)` compares `Items` **by reference** and doesn't stop anyone from calling
`cart.Items.Add(...)`. Value equality and immutability only go one level deep — the same as
`Object.freeze` in JS. Use immutable or read-only collection types inside records if that matters.
:::

| Use | When |
|---|---|
| `class` | Things with **identity** and behaviour that change over time: entities, services |
| `record` | **Data** compared by value: DTOs, API requests/responses, events, query results |
| `struct` / `record struct` | **Small** values (a handful of fields), short-lived, copied often: `Money`, `Point`, coordinates |

### Structs and `record struct`

```csharp
var price = new Money(10m, "EUR");
var same = new Money(10m, "EUR");
Console.WriteLine(price == same);    // True

public readonly record struct Money(decimal Amount, string Currency);
```

`readonly` guarantees no field can change after construction. Use structs sparingly: large structs
are expensive to copy, and a struct always has a default value (`default(Money)` is
`{ Amount = 0, Currency = null }`) — even if your constructor would forbid that.

## Check yourself

:::quiz id=be-01-q1
What does this print?

```csharp
int a = 7;
int b = 2;
Console.WriteLine(a / b);
```

- [ ] `3.5`
- [x] `3`
- [ ] `4`
- [ ] It doesn't compile
> `int / int` is integer division: the result is **truncated toward zero**, so `3` — not rounded to `4`, and not `3.5` (that's the JavaScript answer, where every number is a float). Make one operand floating point to get `3.5`: `a / (double)b` or `7 / 2.0`. It compiles fine, which is exactly why it's a sneaky bug in things like percentage calculations.
:::

:::quiz id=be-01-q2
What does this print?

```csharp
var first = new Counter { Value = 1 };
var second = first;
second.Value = 5;
Console.WriteLine($"{first.Value} {second.Value}");

public struct Counter { public int Value; }
```

- [x] `1 5`
- [ ] `5 5`
- [ ] `1 1`
- [ ] It throws `NullReferenceException`
> `Counter` is a **struct** — a value type. `var second = first;` copies the whole value, so changing `second` doesn't affect `first`. If `Counter` were a `class`, both variables would point at the same object and you'd get `5 5`.
:::

:::quiz id=be-01-q3
Which comparisons print `True`?

```csharp
public class PersonClass { public string Name = ""; }
public record PersonRecord(string Name);
```

- [ ] `new PersonClass { Name = "Ada" } == new PersonClass { Name = "Ada" }`
- [x] `new PersonRecord("Ada") == new PersonRecord("Ada")`
- [x] `"Ada" == string.Concat("A", "da")`
- [x] `new PersonRecord("Ada") == new PersonRecord("Ada") with { }`
> Classes use **reference** equality by default: two separate `new PersonClass` objects are never `==`, even with identical fields — that's the tempting wrong pick. Records generate **value** equality (all properties equal → equal), and `with { }` creates a *new* object that's still equal by value. `string` overrides `==` to compare characters, even though it's a reference type and `string.Concat` builds a separate object.
:::

:::quiz id=be-01-q4
Spot the line that **doesn't compile**.

```csharp
var count = 10;                 // line 1
count = count + 1;              // line 2
var label = $"Count: {count}";  // line 3
count = "eleven";               // line 4
```

- [ ] Line 1 — `var` needs an explicit type
- [ ] Line 3 — you can't interpolate an `int`
- [x] Line 4 — `count` is an `int` forever
- [ ] All lines compile; line 4 fails at runtime
> `var` is **type inference**, not dynamic typing. On line 1 the compiler decides `count` is `int`, and assigning a `string` later is error CS0029. "Fails at runtime" is the JavaScript instinct, but this is caught at **compile** time — the program never gets built, let alone run. Lines 1–3 are fine: `var` only needs an initializer, and interpolation works with any type.
:::

:::quiz id=be-01-q5
With nullable reference types enabled, what is printed?

```csharp
string? nickname = null;
string name = "Ada";
Console.WriteLine(nickname?.Length ?? -1);
Console.WriteLine(nickname ?? name);
```

- [x] `-1` then `Ada`
- [ ] `0` then `Ada`
- [ ] A `NullReferenceException` on the first line
- [ ] A compile error: `nickname` can't be null
> `nickname?.Length` short-circuits to `null` (its type is `int?`) instead of throwing, and `?? -1` replaces that null with `-1`. It's not `0`: `?.` doesn't invent a default length, it produces null. `nickname ?? name` picks the first non-null value, `Ada`. `string?` explicitly allows null, so there's no compile error, and no dereference happens, so no exception.
:::

:::quiz id=be-01-q6
A teammate writes `var user = FindUser(id)!;` and then `user.Email`. `FindUser` returns `User?` and returns `null` when the id doesn't exist. What happens for an unknown id?

- [ ] The `!` makes `FindUser` throw a nice `KeyNotFoundException`
- [ ] The `!` converts null to a default `User`
- [x] The compiler warning disappears, but `user.Email` throws `NullReferenceException` at runtime
- [ ] It doesn't compile
> `!` only silences the compiler's nullable analysis — it generates **no runtime code**, so it can't throw a nicer exception or substitute a default object. `user` is simply null, and the crash happens on `user.Email`. The honest fix is to handle the null: `if (user is null) return Results.NotFound();`.
:::

:::quiz id=be-01-q7
Which type should hold an order total that's stored in PostgreSQL as `numeric(12,2)`?

- [ ] `double`
- [ ] `float`
- [x] `decimal`
- [ ] `long` storing cents is the only correct option
> `decimal` is exact in base 10 (`0.1m + 0.2m == 0.3m` is `True`) and Npgsql maps it directly to `numeric`. Storing cents in a `long` also works and some payment systems do it — which is why "the *only* correct option" is wrong — but it doesn't match a `numeric(12,2)` column and `decimal` is the idiomatic default in .NET. `double`/`float` are binary floating point and introduce rounding errors (`0.1 + 0.2 != 0.3`).
:::

:::quiz id=be-01-q8
What does this print?

```csharp
var home = new Address("London", "UK");
var work = home with { City = "Leeds" };
Console.WriteLine($"{home.City} {work.City} {home == work}");

public record Address(string City, string Country);
```

- [ ] `Leeds Leeds True`
- [x] `London Leeds False`
- [ ] `London Leeds True`
- [ ] It doesn't compile: records are immutable
> `with` creates a **new** record with the listed properties changed — `home` is untouched, so it's not `Leeds Leeds`. The two now differ in `City`, so value equality gives `False` (value equality compares *all* properties, not just some). And it compiles: immutability is exactly why `with` exists — you don't change a record, you copy it.
:::

:::quiz id=be-01-q9
Spot the line that **doesn't compile**.

```csharp
var a = new Point { X = 1 };
var b = new Point { X = 1 };
Console.WriteLine(a.Equals(b));   // line 1
Console.WriteLine(a == b);        // line 2

public struct Point { public int X; }
```

- [ ] Line 1 — structs have no `Equals`
- [x] Line 2 — a plain `struct` has no `==` operator
- [ ] Neither; both print `True`
- [ ] Neither; line 1 prints `True`, line 2 prints `False`
> Every type inherits `Equals` from `object`, and for structs it compares the fields, so line 1 compiles and prints `True`. But C# only gives a struct an `==` operator if you declare one, so line 2 is error CS0019. It's tempting to assume "value type, so `==` compares values", but that's only true for built-in types like `int` and for `record struct`, which generates `==` for you.
:::

:::quiz id=be-01-q10
What happens here?

```csharp
var p = new Product { Name = "Book", Price = 12.5m };
p.Price = 10m;

public class Product
{
    public required string Name { get; init; }
    public required decimal Price { get; init; }
}
```

- [ ] It runs, and `p.Price` is `10`
- [ ] It throws `InvalidOperationException` on the second line
- [x] Compile error: `Price` is `init`-only, so it can only be set in the object initializer
- [ ] Compile error: `required` properties need a constructor
> `init` means "settable while the object is being created" — in a constructor or the `{ ... }` initializer — and never again. The check happens at **compile** time (CS8852), not at runtime. `required` works fine without a constructor: it only forces callers to set the property in the initializer, which this code does.
:::

## Lab: model a tiny domain

:::lab id=be-01-lab1 xp=80
title: Records, structs, nullability — proven by tests

You'll create a class library and a test project, paste in a small domain, and let xUnit prove the
value-vs-reference rules from this lesson. You need the **.NET 10 SDK** (`dotnet --version` should print
`10.x`).

:::info title="First time with the dotnet CLI and xUnit? Read this box first"
Every lab in this track follows the same pattern, so here is the minimum you need. The full stories come
later: **The .NET CLI, Solutions & Projects** (be-05) explains every command below, and
**Testing .NET Code with xUnit** (be-14) teaches testing properly. Both are safe to read early if you
want to.

- `dotnet new sln` / `classlib` / `xunit` create a solution file, a library project and a test project
  from templates. `dotnet sln add` puts projects in the solution; `dotnet add … reference` lets the
  test project see your code.
- In the test project, a test is a public method marked **`[Fact]`** inside a public class. No base
  class, no registration: xUnit finds it by the attribute.
- **`[Theory]`** plus one **`[InlineData(1, 2, 3)]`** line per case runs the same test method once per
  data row, with the values passed as parameters (from be-02 on).
- Inside a test you **arrange** some objects, **act** on them and **assert**:
  `Assert.Equal(expected, actual)`, `Assert.True(cond)`, `Assert.Null(x)`,
  `Assert.Throws<InvalidOperationException>(() => …)`. The first failing assert ends that test.
- **`dotnet test`** (run it from the folder with the `.slnx`) builds everything and runs every test.
  `Passed!` plus a count means green. A failure prints the test name, `Expected:` / `Actual:` and the
  file and line. `dotnet test --filter Name_of_test` runs a single test.
- If the build fails, `dotnet test` prints compiler errors (`error CS…`) instead of test results.
  Fix those first: no test runs until everything compiles.
:::

**1. Create the solution**

```bash
mkdir Basics && cd Basics
dotnet new sln -n Basics
dotnet new classlib -o src/Basics
dotnet new xunit -o tests/Basics.Tests
dotnet sln add src/Basics tests/Basics.Tests
dotnet add tests/Basics.Tests reference src/Basics
rm src/Basics/Class1.cs tests/Basics.Tests/UnitTest1.cs
```

(In PowerShell, separate the paths with a comma: `rm src/Basics/Class1.cs, tests/Basics.Tests/UnitTest1.cs`; in `cmd` use `del` with backslashes.) `dotnet new sln` in .NET 10 creates the
new XML-based `Basics.slnx` solution file.

**2. Add `src/Basics/Money.cs`**

```csharp
using System.Globalization;

namespace Basics;

// A value type with value equality: perfect for small, immutable "values".
public readonly record struct Money(decimal Amount, string Currency)
{
    public static Money Zero(string currency) => new(0m, currency);

    public static Money operator +(Money a, Money b)
    {
        if (a.Currency != b.Currency)
            throw new InvalidOperationException($"Cannot add {a.Currency} and {b.Currency}.");
        return a with { Amount = a.Amount + b.Amount };
    }

    // InvariantCulture: "12.50 EUR" on every machine (a German PC would print "12,50" otherwise).
    public override string ToString() =>
        string.Create(CultureInfo.InvariantCulture, $"{Amount:0.00} {Currency}");
}
```

**3. Add `src/Basics/Customer.cs`**

```csharp
namespace Basics;

public class Customer
{
    public required string Name { get; init; }      // must be set when creating, never changed after
    public string? Nickname { get; set; }            // may be null - and the compiler knows it
    public List<Money> Purchases { get; } = [];      // reference type: the list itself can be mutated

    public string DisplayName => Nickname ?? Name;

    public Money TotalSpent(string currency)
    {
        var total = Money.Zero(currency);
        foreach (var purchase in Purchases)
            total += purchase;
        return total;
    }
}
```

**4. Add `src/Basics/Points.cs`**

```csharp
namespace Basics;

public struct PointStruct { public int X; }
public class PointClass { public int X; }

public static class Mutator
{
    public static void Bump(PointStruct p) => p.X++;      // gets a COPY
    public static void Bump(PointClass p) => p.X++;       // gets a copy of the REFERENCE
    public static void Bump(ref PointStruct p) => p.X++;  // gets the original by reference
}
```

**5. Add the tests: `tests/Basics.Tests/BasicsTests.cs`**

```csharp
using Basics;

namespace Basics.Tests;

public class MoneyTests
{
    [Fact]
    public void Money_has_value_equality()
    {
        var a = new Money(10m, "EUR");
        var b = new Money(10m, "EUR");

        Assert.Equal(a, b);
        Assert.True(a == b);
    }

    [Fact]
    public void Adding_same_currency_sums_amounts()
    {
        var sum = new Money(10.25m, "EUR") + new Money(2.25m, "EUR");

        Assert.Equal(new Money(12.50m, "EUR"), sum);
    }

    [Fact]
    public void Adding_different_currencies_throws()
    {
        Assert.Throws<InvalidOperationException>(() => new Money(1m, "EUR") + new Money(1m, "USD"));
    }

    [Fact]
    public void ToString_is_culture_independent()
    {
        Assert.Equal("12.50 EUR", new Money(12.5m, "EUR").ToString());
    }
}

public class CustomerTests
{
    [Fact]
    public void DisplayName_falls_back_to_name_when_nickname_is_null()
    {
        var customer = new Customer { Name = "Ada" };

        Assert.Null(customer.Nickname);
        Assert.Equal("Ada", customer.DisplayName);

        customer.Nickname = "Countess";
        Assert.Equal("Countess", customer.DisplayName);
    }

    [Fact]
    public void TotalSpent_sums_purchases()
    {
        var customer = new Customer { Name = "Grace" };
        customer.Purchases.Add(new Money(5m, "EUR"));
        customer.Purchases.Add(new Money(7.5m, "EUR"));

        Assert.Equal(new Money(12.5m, "EUR"), customer.TotalSpent("EUR"));
    }
}

public class ValueVsReferenceTests
{
    [Fact]
    public void Struct_is_copied_class_is_shared()
    {
        var s = new PointStruct { X = 1 };
        var c = new PointClass { X = 1 };

        Mutator.Bump(s);
        Mutator.Bump(c);

        Assert.Equal(1, s.X);   // the copy was bumped, not s
        Assert.Equal(2, c.X);   // same object on the heap
    }

    [Fact]
    public void Ref_passes_the_struct_itself()
    {
        var s = new PointStruct { X = 1 };

        Mutator.Bump(ref s);

        Assert.Equal(2, s.X);
    }
}
```

**6. Run the tests**

```bash
dotnet test
```

Expected (timings vary):

```text
Passed!  - Failed:     0, Passed:     8, Skipped:     0, Total:     8, Duration: 13 ms - Basics.Tests.dll (net10.0)
```

**7. Break things on purpose** — this is where the learning happens:

- In `Customer.cs`, change `Nickname ?? Name` to `Nickname!` and run the tests. It compiles without
  a warning, and `DisplayName_falls_back_to_name_when_nickname_is_null` fails with
  `Assert.Equal() Failure` — expected `"Ada"`, actual `null`. **No exception was thrown**: `!` let a
  null slip through silently, which is exactly why it's dangerous. Change it back.
- Add `var c = new Customer();` inside any test. The build fails with
  `error CS9035: Required member 'Customer.Name' must be set in the object initializer or attribute constructor.`
  Remove the line again.
- Change `public readonly record struct Money(decimal Amount, string Currency)` to a plain
  `public readonly struct Money(decimal Amount, string Currency)` and add
  `public decimal Amount { get; init; } = Amount;` and `public string Currency { get; init; } = Currency;`
  inside it (`init`, so the `with` in `operator +` still works).
  The build now fails with CS0019 on `Assert.True(a == b)`: plain structs don't get `==` for free.
  Change it back.
- Replace the body of `ToString` with `$"{Amount:0.00} {Currency}";` (no invariant culture) and run
  `LANG=de_DE.UTF-8 dotnet test` (Linux/macOS; on Windows switch your region to German).
  `ToString_is_culture_independent` fails with `"12,50 EUR"`. Change it back.

- [ ] `dotnet test` shows 8 passing tests
- [ ] I saw `DisplayName_falls_back_to_name_when_nickname_is_null` fail (with `null`, not an exception) when I replaced `??` with `!`
- [ ] I saw compile error CS9035 for a missing `required` member
- [ ] I can explain why `Struct_is_copied_class_is_shared` expects `1` and `2`
:::

## Flashcards

:::cards id=be-01-cards1 title="C# essentials"
Q: What does the C# compiler produce, and who runs it?
A: IL (Intermediate Language) in a `.dll`. The .NET runtime (CLR) JIT-compiles IL to machine code and manages memory with a garbage collector.
Q: Value type vs reference type in one sentence?
A: A value-type variable holds the data and is **copied** on assignment; a reference-type variable holds a pointer to a heap object that is **shared**.
Q: Name four value types and four reference types.
A: Value: `int`, `decimal`, `bool`, `DateTime`, any `struct`/`enum`.
   Reference: `string`, arrays, `List<T>`, any `class`/`record`.
Q: Is `var` dynamic typing?
A: No. It's compile-time inference; the variable's type is fixed forever.
Q: What does `string?` mean with nullable reference types on?
A: "This reference may be null" — compile-time analysis only, no runtime check. `int?` is different: a real `Nullable<int>` struct.
Q: What does the `!` (null-forgiving) operator do at runtime?
A: Nothing. It only silences the compiler warning.
Q: `init` vs `set` on a property?
A: `init` can only be set in a constructor or object initializer; `set` can be called any time.
Q: What does a `record` give you for free?
A: Value equality, readable `ToString()`, deconstruction and `with` expressions (non-destructive copy).
Q: Which numeric type for money?
A: `decimal` (exact base-10). Never `double`/`float`.
Q: Why might `$"{price:0.00}"` produce `12,50`?
A: Formatting uses the current culture. Use `CultureInfo.InvariantCulture` for machine-readable output.
:::

## Recap

- C# compiles to IL; the CLR JIT-compiles and garbage-collects it. Types are **real at runtime**.
- `var` is inference, not dynamic typing. `int / int` truncates; use `decimal` for money.
- **Value types** (structs, numbers, `bool`, `DateTime`) are copied; **reference types** (classes,
  records, strings, arrays, lists) are shared. `ref` passes a value type by reference.
- Classes compare by reference; **records** and `string` compare by value; plain structs have no `==`
  until you define one (or use `record struct`).
- Nullable reference types (`string?`) are compile-time analysis; `!` silences warnings but protects
  nothing. Validate at boundaries.
- Public data = **properties** (`get; set;`, `get; init;`, `required`), never public fields.
- Use `class` for entities/services, `record` for data/DTOs, small `readonly record struct` for values.
- Top-level statements and file-scoped namespaces keep files lean; implicit usings import the basics.
