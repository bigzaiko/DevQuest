---
id: be-02
title: Modern C# — Interfaces, Patterns & C# 14
level: intermediate
minutes: 60
xp: 130
summary: Interfaces and composition, abstract classes, pattern matching and switch expressions, primary constructors, collection expressions, extension members, generics, delegates and lambdas, events, enums and exceptions.
---

The C# you'll write in a 2026 codebase looks very different from C# in 2015 tutorials. Pattern
matching replaced `if`/`else` towers, primary constructors removed constructor boilerplate, collection
expressions replaced `new List<int> { … }`, and C# 14 lets you add **properties** to types you don't
own. This lesson covers the features you'll read and write every day — and, more importantly, **when**
to use which.

## Interfaces: contracts, not code reuse

An **interface** describes *what* something can do, without saying *how*:

```csharp
public interface IEmailSender
{
    Task SendAsync(string to, string subject, string body, CancellationToken ct = default);
}

public sealed class SmtpEmailSender : IEmailSender
{
    public Task SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        // talk to a real SMTP server…
        return Task.CompletedTask;
    }
}

public sealed class FakeEmailSender : IEmailSender     // used in tests
{
    public List<string> Sent { get; } = [];

    public Task SendAsync(string to, string subject, string body, CancellationToken ct = default)
    {
        Sent.Add(to);
        return Task.CompletedTask;
    }
}
```

TypeScript interfaces are **structural** — anything with the right shape matches. C# interfaces are
**nominal**: a class only implements `IEmailSender` if it *says so* (`: IEmailSender`). That's
stricter, but it means the runtime knows exactly which types implement what — which is how the
dependency injection container can hand you an `IEmailSender` (lesson be-08).

Why do backend codebases have so many interfaces? Mostly for **two reasons**:

1. **Testability** — code depending on `IEmailSender` can be tested with `FakeEmailSender`.
2. **Swappable infrastructure** — SMTP today, SendGrid tomorrow, without touching business code.

:::pro title="Don't interface everything"
`IOrderService` with exactly one implementation `OrderService` that's never faked is noise. Senior
reviewers increasingly push back on "an interface for every class". Introduce an interface at a
**boundary** (email, payment provider, clock, file system, external HTTP API) or when you genuinely
have multiple implementations. Your own domain logic usually doesn't need one.
:::

## Inheritance vs composition

C# has single class inheritance (`class Dog : Animal`) plus any number of interfaces.

```csharp
public abstract class Shape                // abstract: can't be instantiated
{
    public abstract double Area();         // abstract: subclasses MUST implement
    public virtual string Describe() =>    // virtual: subclasses MAY override
        $"{GetType().Name} with area {Area():0.##}";
}

public sealed class Circle(double radius) : Shape
{
    public override double Area() => Math.PI * radius * radius;
}

public sealed class Square(double side) : Shape
{
    public override double Area() => side * side;
    public override string Describe() => $"Square {side}x{side}";
}
```

- `abstract` member → no body, must be overridden.
- `virtual` member → has a default, may be overridden with `override`.
- Methods are **not virtual by default** (unlike Java/JS, where every method can be overridden). If
  a base method isn't `virtual`, a subclass can't override it — declaring a method with the same name
  only *hides* it (the compiler warns with CS0108 until you add the `new` keyword to say "yes, on
  purpose"). Which version runs then depends on the variable's **compile-time** type — almost always
  a bug.
- `sealed` → nobody can inherit from this class. Mark classes `sealed` unless they're designed for
  inheritance (it's also slightly faster).

**Inheritance** says "a Square *is a* Shape". **Composition** says "an OrderService *has an*
IEmailSender". Prefer composition for sharing behaviour — inheritance chains (`BaseService` →
`CrudService<T>` → `OrderService`) become rigid fast: every change to a base class ripples through
every subclass, and you inherit methods you don't want.

```csharp
// ❌ Inheritance for reuse: OrderService now "is a" logger?
public class OrderService : LoggingServiceBase { }

// ✅ Composition: OrderService has what it needs, injected
public sealed class OrderService(IEmailSender email, ILogger<OrderService> logger) { }
```

:::job title="Where you'll still see inheritance"
Framework extension points: `DbContext` (EF Core), `ControllerBase` (MVC), `BackgroundService`
(hosted workers), `Exception` (your custom exceptions), `JsonConverter<T>`. You inherit from the
framework; your own business classes rarely inherit from each other.
:::

## Primary constructors

Since C# 12, **any** class or struct can have a primary constructor — parameters right after the type
name, in scope for the whole body:

```csharp
// Before
public sealed class OrderService
{
    private readonly IEmailSender _email;
    private readonly ILogger<OrderService> _logger;

    public OrderService(IEmailSender email, ILogger<OrderService> logger)
    {
        _email = email;
        _logger = logger;
    }
}

// After
public sealed class OrderService(IEmailSender email, ILogger<OrderService> logger)
{
    public async Task PlaceAsync(Order order)
    {
        logger.LogInformation("Placing order {OrderId}", order.Id);
        await email.SendAsync(order.CustomerEmail, "Thanks!", "…");
    }
}
```

The key differences from **record** primary constructors:

| | `record Person(string Name)` | `class Person(string name)` |
|---|---|---|
| Creates a public property? | ✅ `Name { get; init; }` | ❌ just a parameter |
| Accessible from outside? | `person.Name` | No |
| Readonly? | Property is init-only | Parameter is **mutable** (you can reassign it in the body) |

That's why the convention is PascalCase for record parameters (they become properties) and camelCase
for class parameters (they're just captured variables). For DI services, primary constructors are now
the standard style. If you want the "can't accidentally reassign" guarantee, assign to a field:
`private readonly IEmailSender _email = email;`.

How does the class "remember" a parameter? If a member (not just an initializer) uses it, the
compiler quietly generates a hidden private field to store it — that's what "captured" means. A
common mistake is to capture the parameter **and** also copy it into your own field, so the class
stores the same value twice; the compiler warns about this (CS9124) — pick one style.

:::tip title="Primary constructors in one sentence"
`class OrderService(IEmailSender email)` = "this class has a constructor taking `email`, and every
member may use `email`". Nothing more: no property, no field you can see, no `readonly`.
:::

## `required`, `init` and object initializers

Recap from be-01, because you'll combine them with everything here:

```csharp
public sealed class CreateUserCommand
{
    public required string Email { get; init; }
    public required string DisplayName { get; init; }
    public string? Referrer { get; init; }
}

var cmd = new CreateUserCommand { Email = "ada@example.com", DisplayName = "Ada" };
```

`required` = "must be set at creation", `init` = "can't change afterwards". Together they give you
immutable objects without writing a constructor.

## Collection expressions

Before C# 12 every collection had its own creation syntax: `new int[] { 1, 2 }`,
`new List<int> { 1, 2 }`, `ImmutableArray.Create(1, 2)`, `Array.Empty<int>()`. C# 12 unified them with
`[...]` — it works for arrays, `List<T>`, `Span<T>`, `HashSet<T>`, immutable collections and more. The
**target type** (the declared type of the variable, parameter or property you're assigning to) decides
what's built:

```csharp
int[] numbers = [1, 2, 3];
List<string> names = ["Ada", "Grace"];
HashSet<string> tags = ["dotnet", "csharp"];
IReadOnlyList<int> empty = [];

int[] more = [0, .. numbers, 4];      // spread with .. (like JS ...): [0, 1, 2, 3, 4]

public sealed class Basket
{
    public List<string> Items { get; } = [];   // the most common use: initialise empty collections
}
```

`var x = [1, 2];` does **not** compile — there's no target type to decide what to build.

## Pattern matching

Pattern matching lets you test a value's **type and shape** and pull data out in one step — instead
of a cast, a null check and three `&&` comparisons. You'll use it with `is` and with `switch`. The
building blocks:

| Pattern | Example | Matches when… |
|---|---|---|
| Type (+ declaration) | `value is int n` | `value` is an `int`; the result is available as `n` |
| Constant | `status is OrderStatus.Paid`, `x is null` | equal to that constant |
| Relational | `score is >= 90` | the comparison is true (`<`, `<=`, `>`, `>=`) |
| Logical | `is >= 0 and <= 100`, `is "DE" or "AT"`, `is not null` | combines patterns |
| Property | `order is { Total: > 100m }` | non-null **and** each listed property matches |
| List (C# 11) | `args is [var first, ..]` | the sequence has that shape (`..` = "any number of items") |
| Discard | `_` | always |

```csharp
object value = 42;

if (value is int n && n > 40) Console.WriteLine($"big int {n}");   // type pattern + declaration

if (value is not null) { }                       // the idiomatic null check
if (text is { Length: > 3 }) { }                 // property pattern: non-null AND length > 3
if (order is { Status: OrderStatus.Paid, Total: > 100m }) { }      // nested property patterns
if (score is >= 0 and <= 100) { }                // relational + logical patterns
if (day is DayOfWeek.Saturday or DayOfWeek.Sunday) { }
if (args is [var first, .. var rest]) { }        // list pattern (C# 11)
```

A declared variable like `n` is only **definitely assigned** where the pattern is known to have
matched: inside the `if`, or after `&&` in the same condition. Using `n` in the `else` branch is a
compile error.

:::tip title="`is null` vs `== null`"
`x is null` always means "is the reference null". `x == null` calls an overloadable `==` operator
that a type *could* redefine. Prefer `is null` / `is not null`.
:::

### Switch expressions

A **switch expression** is an expression (it produces a value), with one arm per pattern:

```csharp
public static decimal ShippingCost(Order order) => order switch
{
    { Total: >= 100m } => 0m,                             // free shipping
    { Country: "DE" or "AT" } => 4.90m,
    { Country: "US", IsExpress: true } => 29m,
    { Country: "US" } => 15m,
    _ => 9.90m,                                           // discard = default
};
```

Rules that matter:

1. **Arms are tried top to bottom; the first match wins.** Put specific arms before general ones.
2. If an arm can never match because an earlier arm already covers it, that's a **compile error**
   (CS8510) — the compiler protects you from dead arms.
3. If no arm matches at runtime, you get a `SwitchExpressionException`. The compiler warns (CS8509)
   when it can see that your arms aren't exhaustive — add a `_` arm or cover every case.

When a condition can't be written as a pattern (a method call, a comparison between two
properties), add a **case guard** with `when`: `CardPayment c when Eu.Contains(c.Country) => …`. The
arm only matches if the pattern matches *and* the guard is true.

Type patterns shine with a family of records:

```csharp
public abstract record Payment(decimal Amount);
public sealed record CardPayment(decimal Amount, string Country, bool IsBusinessCard) : Payment(Amount);
public sealed record PayPalPayment(decimal Amount, string Email) : Payment(Amount);
public sealed record BankTransfer(decimal Amount, string Iban) : Payment(Amount);

public static decimal Fee(Payment payment) => payment switch
{
    { Amount: <= 0 } => throw new ArgumentOutOfRangeException(nameof(payment)),
    CardPayment { IsBusinessCard: true } c => c.Amount * 0.029m,
    CardPayment c => c.Amount * 0.014m,
    PayPalPayment p => p.Amount * 0.034m + 0.35m,
    BankTransfer { Amount: < 1000 } => 0m,
    BankTransfer => 1.50m,
    _ => throw new NotSupportedException(payment.GetType().Name),
};
```

This is the C# equivalent of a TypeScript **discriminated union** with a `switch (p.kind)`. C# doesn't
(yet) check exhaustiveness for class hierarchies, which is why the final `_` arm is there.

## Extension methods and C# 14 extension members

**Extension methods** add methods to types you don't own — LINQ's `.Where()` and `.Select()` on every
`IEnumerable<T>` are extension methods. Classic syntax: a `static` method in a `static` class, with
`this` before the first parameter:

```csharp
// Usage (e.g. in Program.cs, above any type declarations):
"DE89370400440532013000".Mask();   // "******************3000"

// StringExtensions.cs
public static class StringExtensions
{
    public static string Mask(this string value, int visible = 4) =>
        value.Length <= visible ? value : new string('*', value.Length - visible) + value[^visible..];
}
```

**C# 14** (ships with .NET 10) adds **extension blocks**, which can declare extension **properties**
and **static** extension members, not just instance methods:

```csharp
// Usage (e.g. in Program.cs, above any type declarations):
string? input = "  ";
Console.WriteLine(input.IsBlank);            // True — reads like a real property
Console.WriteLine(string.Separator);         // static extension: looks like it's on string

// StringExtensions.cs
public static class StringExtensions
{
    extension(string? value)                     // the receiver: what we're extending
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(value);    // extension PROPERTY
        public string OrDefault(string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    extension(string)                            // no receiver name = static members
    {
        public static string Separator => " | ";
    }
}
```

Extension methods are just syntax sugar for static calls (`StringExtensions.Mask(x)`), so they can't
access private members and they only show up when their namespace is imported with `using`.

:::warn title="Extension pitfalls"
- They're resolved at **compile time**: no polymorphism. An instance method with the same signature
  always wins over an extension.
- An extension on `string?` can be called on `null` without crashing — great for `IsBlank`,
  surprising for anything else.
- Don't put business logic in extensions on `object` or `string`; it becomes invisible global state.
:::

## Generics basics

Generics let you write code once for many types while keeping full type safety — `List<T>`,
`Dictionary<TKey, TValue>`, `Task<T>`. You can write your own:

```csharp
// Usage (e.g. in Program.cs, above any type declarations):
var r = Result<int>.Success(42);

// Result.cs
public sealed class Result<T>
{
    public bool IsSuccess { get; }
    public T? Value { get; }
    public string? Error { get; }

    private Result(bool ok, T? value, string? error) => (IsSuccess, Value, Error) = (ok, value, error);

    public static Result<T> Success(T value) => new(true, value, null);
    public static Result<T> Failure(string error) => new(false, default, error);
}
```

**Constraints** restrict what `T` can be, which lets you call members of `T`:

```csharp
MathUtil.Max(3, 7);          // 7 — T inferred as int
MathUtil.Max("a", "b");      // "b"

public static class MathUtil
{
    public static T Max<T>(T a, T b) where T : IComparable<T> =>
        a.CompareTo(b) >= 0 ? a : b;
}
```

Common constraints: `where T : class` (reference type), `where T : struct` (value type),
`where T : new()` (has a parameterless constructor), `where T : SomeBaseOrInterface`,
`where T : notnull`.

Unlike TypeScript (erased) or Java (type erasure), .NET generics are **reified**: `List<int>` and
`List<string>` are distinct types at runtime, and `List<int>` stores raw `int`s with no **boxing**.
(Boxing = wrapping a value type in a heap object so it can be treated as `object`. The old
non-generic `ArrayList` boxed every `int` you added — one allocation per item.) Reification is also why
`typeof(T)` and `x is T` work inside generic code.

## Delegates, lambdas, events & enums

### Functions as values: `Func`, `Action` and delegates

In TypeScript a function is just a value: `const f: (x: number) => number = x => x * 2`. C# can do the
same, but the variable needs a **delegate type**, which is a type that describes a method signature.
You'll almost always use one of the built-in generic ones:

| Delegate | Signature | TypeScript equivalent |
|---|---|---|
| `Action` | no parameters, returns nothing | `() => void` |
| `Action<string>` | takes a `string`, returns nothing | `(s: string) => void` |
| `Func<int>` | no parameters, returns `int` | `() => number` |
| `Func<int, int, bool>` | takes two `int`s, returns `bool` (the **last** type is the return type) | `(a: number, b: number) => boolean` |
| `Predicate<T>` | takes a `T`, returns `bool` (older APIs like `List<T>.FindAll`) | `(x: T) => boolean` |

```csharp
Func<decimal, decimal> addVat = net => net * 1.19m;      // a lambda stored in a variable
Action<string> log = msg => Console.WriteLine($"[app] {msg}");

log($"Gross: {addVat(100m)}");                            // [app] Gross: 119.00

// Methods that take behaviour as a parameter: this is what LINQ is built on.
static IEnumerable<T> Keep<T>(IEnumerable<T> items, Func<T, bool> predicate)
{
    foreach (var item in items)
        if (predicate(item)) yield return item;
}

var bigOrders = Keep([5m, 250m, 40m], total => total > 100m);   // [250]
```

A lambda can **capture** local variables, just like a JavaScript closure. It captures the *variable*,
not a copy of its value, so a later change is visible inside the lambda:

```csharp
var threshold = 100m;
Func<decimal, bool> isBig = t => t > threshold;
threshold = 1_000m;
Console.WriteLine(isBig(250m));   // False: the lambda sees the current threshold
```

You can declare your own named delegate (`public delegate decimal PriceRule(decimal price);`), and
you'll see these in older code. In new code, `Func`/`Action` are the default; reach for a named
delegate (or better, a small interface) only when the name documents something the signature doesn't.
ASP.NET Core leans on lambdas everywhere: `app.MapGet("/", () => "hi")` passes a delegate, and
`builder.Services.AddSingleton(sp => new Foo(...))` passes a factory `Func<IServiceProvider, Foo>`.

:::tip title="Lambda or method group"
`items.Where(x => IsValid(x))` and `items.Where(IsValid)` do the same thing. The second form, a
**method group**, passes the method itself. IDEs suggest it, and it's purely a style choice.
:::

### Events: delegates with a subscription list

An **event** is a delegate field that outsiders can only `+=` (subscribe) and `-=` (unsubscribe), and
only the declaring class can raise. It's C#'s built-in observer pattern, much like
`addEventListener` in the DOM:

```csharp
public sealed class Thermostat
{
    public event EventHandler<decimal>? TemperatureChanged;   // EventHandler<T>: (object? sender, T args)

    public void Report(decimal celsius) => TemperatureChanged?.Invoke(this, celsius);  // ?. = no subscribers, no call
}

var t = new Thermostat();
EventHandler<decimal> handler = (_, c) => Console.WriteLine($"Now {c} °C");
t.TemperatureChanged += handler;
t.Report(21.5m);                       // Now 21.5 °C
t.TemperatureChanged -= handler;       // unsubscribe, or the publisher keeps the subscriber alive
```

Events appear in UI frameworks and some library types (`FileSystemWatcher.Changed`, `Process.Exited`,
`AppDomain.UnhandledException`). In web APIs you'll rarely declare your own: request-scoped code uses
DI and method calls, and cross-service "events" mean messages on a broker, which is a different
thing entirely (see **Message Brokers & the Outbox Pattern** in the Cloud-Native Toolkit). The classic
bug is a long-lived publisher (a singleton) holding subscribers that never unsubscribe. That is a
memory leak, because the GC can't collect anything the publisher still references.

### Enums: named numbers, and their JSON trap

An `enum` is a set of named integer constants. It is **not** a string union like TypeScript's
`'draft' | 'published'`:

```csharp
public enum OrderStatus { Draft, Submitted, Shipped, Cancelled }   // 0, 1, 2, 3 under the hood

var s = OrderStatus.Shipped;
Console.WriteLine(s);                 // Shipped
Console.WriteLine((int)s);            // 2

var weird = (OrderStatus)42;          // compiles and runs: an enum is just an int with names
Console.WriteLine(Enum.IsDefined(weird));   // False: validate input before trusting it

var label = s switch                  // switch expressions pair naturally with enums
{
    OrderStatus.Draft     => "Not sent yet",
    OrderStatus.Submitted => "Waiting",
    OrderStatus.Shipped   => "On its way",
    OrderStatus.Cancelled => "Cancelled",
    _ => throw new ArgumentOutOfRangeException(nameof(s)),   // the int can hold any value
};
```

Three traps you'll meet in real APIs:

1. **JSON writes numbers by default.** `System.Text.Json` serializes `OrderStatus.Shipped` as `2`. Your
   React client then has to know that `2` means "shipped". Most teams switch to strings globally:
   `builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));`
   (be-06 covers JSON options).
2. **Reordering breaks stored data.** If the database or a message stores the number `2` and someone
   inserts `Paid` before `Shipped`, every old "shipped" row now reads as `Paid`. Give persisted enums
   **explicit values** (`Shipped = 2`) or store them as strings (be-11 shows EF Core's enum-to-string
   mapping).
3. **Flags.** `[Flags] enum Permission { None = 0, Read = 1, Write = 2, Delete = 4 }` lets you combine
   values with `|` (`Read | Write`) and test them with `p.HasFlag(Permission.Write)`. Use powers of two,
   or the combinations collide.

## Exceptions

Exceptions signal that something **exceptional** went wrong. They work like JS `throw`/`try`/`catch`,
with typed `catch` blocks:

```csharp
try
{
    var order = await repository.GetAsync(id);
    await payments.ChargeAsync(order);
}
catch (PaymentDeclinedException ex) when (ex.Retryable)     // exception filter
{
    logger.LogWarning(ex, "Payment declined, will retry");
}
catch (HttpRequestException ex)
{
    logger.LogError(ex, "Payment provider unreachable");
    throw;                                  // rethrow, keeping the original stack trace
}
finally
{
    // always runs: success, exception or return
}
```

Your own exceptions inherit from `Exception`:

```csharp
public sealed class PaymentDeclinedException(string message, bool retryable)
    : Exception(message)
{
    public bool Retryable { get; } = retryable;
}
```

Guard clauses use the built-in throw helpers:

```csharp
ArgumentNullException.ThrowIfNull(order);
ArgumentException.ThrowIfNullOrWhiteSpace(email);
ArgumentOutOfRangeException.ThrowIfNegativeOrZero(quantity);
```

:::pro title="Code review comments you'll get about exceptions"
- *"`throw ex;` resets the stack trace — use `throw;`."*
- *"Don't `catch (Exception)` and swallow it. Either handle it meaningfully, or let it bubble to the
  global exception handler (be-09)."*
- *"Don't use exceptions for control flow."* Expected outcomes — not found, validation failed,
  duplicate email — are **results**, not exceptions. Return `null`, a `bool`, or a result type and map
  it to a 404/400/409. Throwing costs microseconds (stack trace capture, unwinding) versus nanoseconds for a `return`,
  and it hides the happy path.
- *"Use `using` / `await using` for disposables"* so resources are released even when exceptions fly.
:::

Some objects hold resources the garbage collector doesn't manage well — file handles, sockets,
database connections. They implement `IDisposable` (a `Dispose()` method that releases the resource
now). `using` is C#'s `try/finally` that calls `Dispose()` for you:

```csharp
using var stream = File.OpenRead("data.csv");   // Dispose() runs at the end of the enclosing scope
// …read…                                       // even if an exception is thrown here
```

Forgetting `using` doesn't crash immediately: the file stays locked, or the connection pool slowly runs
dry under load. `await using` does the same for `IAsyncDisposable` (e.g. `DbContext`, `NpgsqlConnection`).

## Check yourself

:::quiz id=be-02-q1
What does this print?

```csharp
Animal pet = new Dog();
Console.WriteLine(pet.Speak());

public class Animal { public virtual string Speak() => "..."; }
public class Dog : Animal { public override string Speak() => "Woof"; }
```

- [x] `Woof`
- [ ] `...`
- [ ] It doesn't compile: `pet` is an `Animal`
> `virtual` + `override` means the method is chosen by the object's **runtime** type (`Dog`), not the variable's declared type (`Animal`) — that's polymorphism, so it isn't `...`. It compiles because `Speak` exists on `Animal`; the compiler only checks that the call is valid for the declared type, and the runtime picks the override.
:::

:::quiz id=be-02-q2
Now `Dog` uses `new` instead of `override`, and `Speak` in `Animal` is not virtual. What does it print?

```csharp
Animal pet = new Dog();
Console.WriteLine(pet.Speak());

public class Animal { public string Speak() => "..."; }
public class Dog : Animal { public new string Speak() => "Woof"; }
```

- [ ] `Woof`
- [x] `...`
- [ ] It throws at runtime
> `new` **hides** the base method instead of overriding it. Non-virtual calls are bound at compile time to the variable's type (`Animal`), so `Animal.Speak` runs. Calling through a `Dog` variable would print `Woof` — two different answers for the same object is why hiding is almost always a bug.
:::

:::quiz id=be-02-q3
Why doesn't this switch expression compile?

```csharp
static string Label(Payment p) => p switch
{
    CardPayment c => "card",
    CardPayment { IsBusinessCard: true } c => "business card",
    PayPalPayment => "paypal",
    _ => "other",
};
```

- [ ] Switch expressions can't use property patterns
- [x] The second arm is already handled by the first one (error CS8510); swap them
- [ ] The `_` arm must come first
- [ ] You can't declare `c` twice
> Arms are evaluated top to bottom. `CardPayment c` matches **every** card, so the more specific business-card arm can never be reached — the compiler reports it as error CS8510. Specific patterns go first. Reusing the name `c` is fine: each arm has its own scope. And `_` must come **last**, not first — first it would swallow everything.
:::

:::quiz id=be-02-q4
Which statements about this class are true?

```csharp
public sealed class InvoiceService(IEmailSender sender)
{
    public Task SendAsync(string to) => sender.SendAsync(to, "Invoice", "...");
}
```

- [x] `sender` is in scope in all members of the class
- [ ] `new InvoiceService(x).Sender` returns the injected sender
- [x] `sender` could be reassigned inside the class body
- [ ] It's the same as `public record InvoiceService(IEmailSender Sender)`
> A **class** primary constructor parameter is a captured, mutable parameter, visible in every member — but no property is generated, so `.Sender` doesn't exist (that's the record behaviour, and why the record option is wrong too: a record would expose `Sender` publicly and add value equality). Assign it to a `private readonly` field if you want immutability.
:::

:::quiz id=be-02-q5
What does this print?

```csharp
int[] core = [2, 3];
List<int> all = [1, .. core, 4];
Console.WriteLine(string.Join(",", all));
```

- [ ] `1,2,3,4` — but only for arrays; this is a compile error for `List<int>`
- [x] `1,2,3,4`
- [ ] `1,[2,3],4`
- [ ] `1,..core,4`
> Collection expressions work for any supported target type — `List<int>` included, so the first option is wrong — and `..` spreads the *elements* of another collection (it doesn't nest the array) — like `[1, ...core, 4]` in JavaScript.
:::

:::quiz id=be-02-q6
A teammate wrote this. What's the problem?

```csharp
catch (HttpRequestException ex)
{
    logger.LogError(ex, "Provider failed");
    throw ex;
}
```

- [ ] Nothing — it rethrows the same exception
- [x] `throw ex;` resets the stack trace to this line; use `throw;` to preserve where it really happened
- [ ] You must wrap it: `throw new Exception(ex)`
- [ ] Logging and rethrowing is forbidden in C#
> `throw ex;` throws the exception object again **from here**, losing the original stack trace. Bare `throw;` rethrows the current exception unchanged. (Logging *and* rethrowing also tends to log the same error twice — often you'd do one or the other.)
:::

:::quiz id=be-02-q7
Which patterns match `string? s = "hello";`? (select all)

- [x] `s is { Length: > 3 }`
- [x] `s is not null`
- [ ] `s is { Length: < 3 }`
- [x] `s is ['h', ..]`
> `{ Length: > 3 }` is a property pattern that also implies non-null; `"hello"` has length 5, so it matches and `{ Length: < 3 }` doesn't. `['h', ..]` is a list pattern — "first char is `h`, then anything" — and strings support it because they have `Length` and an indexer. `is not null` is the idiomatic null check.
:::

:::quiz id=be-02-q8
Which use of an exception is **most** likely to get pushback in code review?

- [ ] Throwing `ArgumentNullException` when a required constructor argument is null
- [x] Throwing `UserNotFoundException` from a lookup and catching it in the endpoint to return 404 on every unknown id
- [ ] Letting an unexpected `NpgsqlException` bubble up to the global exception handler
- [ ] Defining a custom exception that inherits from `Exception`
> A user id that doesn't exist is an **expected** outcome of a lookup, not an exceptional one. Return `null` (or a result type) and map it to `404` — it's faster, clearer, and keeps exceptions for bugs and infrastructure failures. (Some teams do map domain exceptions to HTTP codes centrally, but using try/catch around each lookup as control flow is the smell.)
:::

:::quiz id=be-02-q9
Using the C# 14 extension block from this lesson, what happens?

```csharp
string? input = null;
Console.WriteLine(input.IsBlank);

public static class StringExtensions
{
    extension(string? value)
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(value);
    }
}
```

- [ ] `NullReferenceException` — you can't access a property on `null`
- [x] It prints `True`
- [ ] It prints `False`
- [ ] Compile error: extension properties don't exist in C#
> An extension member is compiled into a **static** method that receives `input` as an ordinary argument, so calling it on `null` doesn't dereference anything — `string.IsNullOrWhiteSpace(null)` is `true`. A real instance property on a null reference would throw, which is the tempting answer. Extension properties are new in C# 14 (.NET 10); before that only extension *methods* existed.
:::

:::quiz id=be-02-q10
Why does this generic method **not** compile?

```csharp
public static T Larger<T>(T a, T b) => a.CompareTo(b) >= 0 ? a : b;
```

- [ ] Generic methods can't use the conditional operator `?:`
- [x] Without a constraint, `T` could be any type, so the compiler only allows members of `object` — and `CompareTo` isn't one
- [ ] `T` must be declared on the class, not the method
- [ ] It compiles; it fails at runtime for types that aren't comparable
> The compiler type-checks generic code **once**, for every possible `T`. Unconstrained, `T` only guarantees what `object` has (`Equals`, `GetHashCode`, `ToString`…). Adding `where T : IComparable<T>` promises `CompareTo` exists, and the call compiles. C# doesn't defer this to runtime the way JavaScript would — that's the point of generics. (The exact error text varies: the compiler may even complain about some unrelated `CompareTo` extension method it tried as a fallback. The cause is the missing constraint.)
:::

:::quiz id=be-02-q11
What does this print?

```csharp
var rate = 0.10m;
Func<decimal, decimal> discount = price => price * rate;
rate = 0.50m;
Console.WriteLine(discount(100m));
```

- [ ] `10.00`: the lambda copied `rate` when it was created
- [x] `50.00`: the lambda captured the variable `rate`, so it sees the later assignment
- [ ] Compile error: a lambda can't use a local variable that changes later
- [ ] `100`: `Func` ignores captured variables
> C# lambdas are closures, just like arrow functions in JavaScript. They capture the **variable**, not a snapshot of its value, so the call sees `0.50m` and `100 × 0.50 = 50.00`. This bites in loops and long-lived callbacks. If you need the value as it was, copy it into a new local first (`var r = rate;`) and capture that.
:::

:::quiz id=be-02-q12
An API returns `public enum Priority { Low, High }` in its JSON with the default `System.Text.Json` settings. Later someone changes it to `{ Low, Medium, High }` and the database stores the enum as an integer. Which statements are true? (Select all that apply.)

- [x] Before the change, the React client received `"priority": 1` for `High`, not `"High"`
- [x] After the change, every row stored as `1` (meant: `High`) now reads as `Medium`
- [ ] The compiler warns that inserting `Medium` changes existing values
- [x] Giving the members explicit values (`Low = 0, High = 1, Medium = 2`) or storing enums as strings avoids the data problem
> An enum is a named integer, and by default both `System.Text.Json` and EF Core use the number. Inserting a member in the middle renumbers everything after it, and nothing warns you, because numbering by position is legal C#. Explicit values make the numbers stable. `JsonStringEnumConverter` and EF Core's `HasConversion<string>()` make the wire format and the stored value the readable name instead.
:::

## Lab: payments with patterns, composition and extensions

:::lab id=be-02-lab1 xp=90
title: Fee calculator, receipt service and C# 14 extensions

You'll build a small payments library that uses a record hierarchy, a switch expression, an
interface for an external dependency, and both kinds of extensions — then prove it with 14 xUnit tests.

(New to `dotnet new`, `dotnet test` and `[Fact]`? The box at the start of the be-01 lab covers the minimum; be-05 and be-14 explain the CLI and xUnit in full.)

**1. Create the projects**

```bash
mkdir Payments && cd Payments
dotnet new sln -n Payments
dotnet new classlib -o src/Payments
dotnet new xunit -o tests/Payments.Tests
dotnet sln add src/Payments tests/Payments.Tests
dotnet add tests/Payments.Tests reference src/Payments
rm src/Payments/Class1.cs tests/Payments.Tests/UnitTest1.cs
```

**2. `src/Payments/Payment.cs`** — a closed family of records:

```csharp
namespace Payments;

// abstract = you can't create a plain "Payment".
public abstract record Payment(decimal Amount);

public sealed record CardPayment(decimal Amount, string Country, bool IsBusinessCard) : Payment(Amount);
public sealed record PayPalPayment(decimal Amount, string Email) : Payment(Amount);
public sealed record BankTransfer(decimal Amount, string Iban) : Payment(Amount);
```

**3. `src/Payments/FeeCalculator.cs`** — try writing `Fee` yourself from the rules in the comment
first, then compare with this version:

```csharp
namespace Payments;

public static class FeeCalculator
{
    // Rules (what product asked for):
    //  - Amount must be > 0, otherwise ArgumentOutOfRangeException
    //  - Business cards: 2.9% ; EU consumer cards: 1.4% ; other consumer cards: 2.5%
    //  - PayPal: 3.4% + 0.35 fixed
    //  - Bank transfer: free under 1000, otherwise flat 1.50
    private static readonly HashSet<string> Eu = ["AT", "BE", "DE", "ES", "FR", "IT", "NL"];   // a sample, not all 27

    public static decimal Fee(Payment payment) => payment switch
    {
        { Amount: <= 0 } => throw new ArgumentOutOfRangeException(nameof(payment), "Amount must be positive."),
        CardPayment { IsBusinessCard: true } c => Round(c.Amount * 0.029m),
        CardPayment c when Eu.Contains(c.Country) => Round(c.Amount * 0.014m),
        CardPayment c => Round(c.Amount * 0.025m),
        PayPalPayment p => Round(p.Amount * 0.034m + 0.35m),
        BankTransfer { Amount: < 1000 } => 0m,
        BankTransfer => 1.50m,
        _ => throw new NotSupportedException($"Unknown payment type {payment.GetType().Name}"),
    };

    private static decimal Round(decimal value) => Math.Round(value, 2, MidpointRounding.AwayFromZero);
}
```

Note the `when` clause: a **case guard** for conditions a pattern can't express.

**4. `src/Payments/StringExtensions.cs`** — classic and C# 14 extensions side by side:

```csharp
namespace Payments;

public static class StringExtensions
{
    // Classic extension method (C# 3+)
    public static string Mask(this string value, int visible = 4) =>
        value.Length <= visible ? value : new string('*', value.Length - visible) + value[^visible..];

    // C# 14 extension block: extension PROPERTIES and static members
    extension(string? value)
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(value);
    }

    extension(string)
    {
        public static string Separator => " | ";
    }
}
```

**5. `src/Payments/Notifications.cs`** — composition through an interface:

```csharp
namespace Payments;

public interface INotifier
{
    Task NotifyAsync(string recipient, string message, CancellationToken ct = default);
}

// Composition: the receipt service HAS a notifier (any implementation), it doesn't inherit from one.
public sealed class ReceiptService(INotifier notifier)
{
    public async Task SendReceiptAsync(Payment payment, string recipient, CancellationToken ct = default)
    {
        if (recipient.IsBlank) throw new ArgumentException("Recipient is required.", nameof(recipient));

        var fee = FeeCalculator.Fee(payment);
        var method = payment switch
        {
            CardPayment => "Card",
            PayPalPayment p => $"PayPal{string.Separator}{p.Email}",
            BankTransfer b => $"Bank{string.Separator}{b.Iban.Mask()}",
            _ => "Unknown",
        };
        await notifier.NotifyAsync(recipient, $"Paid {payment.Amount:0.00} via {method} (fee {fee:0.00})", ct);
    }
}
```

**6. `tests/Payments.Tests/PaymentTests.cs`**

```csharp
using Payments;

namespace Payments.Tests;

public class FeeCalculatorTests
{
    [Theory]
    [InlineData("DE", false, 100, 1.40)]
    [InlineData("US", false, 100, 2.50)]
    [InlineData("DE", true, 100, 2.90)]
    public void Card_fees_depend_on_country_and_card_type(string country, bool business, decimal amount, decimal expected)
    {
        Assert.Equal(expected, FeeCalculator.Fee(new CardPayment(amount, country, business)));
    }

    [Fact]
    public void PayPal_has_percentage_plus_fixed_fee()
    {
        Assert.Equal(3.75m, FeeCalculator.Fee(new PayPalPayment(100m, "a@b.c")));
    }

    [Theory]
    [InlineData(999.99, 0)]
    [InlineData(1000, 1.50)]
    public void Bank_transfer_is_free_below_1000(decimal amount, decimal expected)
    {
        Assert.Equal(expected, FeeCalculator.Fee(new BankTransfer(amount, "DE89370400440532013000")));
    }

    [Fact]
    public void Non_positive_amounts_are_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => FeeCalculator.Fee(new PayPalPayment(0m, "a@b.c")));
    }

    [Fact]
    public void Records_compare_by_value()
    {
        Assert.Equal(new CardPayment(5m, "DE", false), new CardPayment(5m, "DE", false));
    }
}

public class ExtensionTests
{
    [Theory]
    [InlineData(null, true)]
    [InlineData("   ", true)]
    [InlineData("x", false)]
    public void IsBlank_works_on_null_and_whitespace(string? value, bool expected)
    {
        Assert.Equal(expected, value.IsBlank);
    }

    [Fact]
    public void Mask_keeps_the_last_four_characters()
    {
        Assert.Equal("******3000", "DE89123000".Mask());
    }
}

public class ReceiptServiceTests
{
    // A hand-written fake: no mocking library needed when the interface is small.
    private sealed class FakeNotifier : INotifier
    {
        public List<(string To, string Message)> Sent { get; } = [];

        public Task NotifyAsync(string recipient, string message, CancellationToken ct = default)
        {
            Sent.Add((recipient, message));
            return Task.CompletedTask;
        }
    }

    [Fact]
    public async Task Sends_a_receipt_with_a_masked_iban()
    {
        var notifier = new FakeNotifier();
        var service = new ReceiptService(notifier);

        await service.SendReceiptAsync(new BankTransfer(50m, "DE89370400440532013000"), "ada@example.com");

        var (to, message) = Assert.Single(notifier.Sent);
        Assert.Equal("ada@example.com", to);
        Assert.Contains("Bank | ******************3000", message);
        Assert.DoesNotContain("DE8937", message);
    }

    [Fact]
    public async Task Blank_recipient_is_rejected()
    {
        var service = new ReceiptService(new FakeNotifier());

        await Assert.ThrowsAsync<ArgumentException>(() => service.SendReceiptAsync(new PayPalPayment(1m, "x@y.z"), " "));
    }
}
```

`[Theory]` + `[InlineData]` runs the same test with several inputs — xUnit's table-driven tests.

**7. Run**

```bash
dotnet test
```

Expected: `Passed!  - Failed:     0, Passed:    14, Skipped:     0, Total:    14`.

**8. Experiments**

- Move the last card arm (`CardPayment c => Round(c.Amount * 0.025m)`, the one without `when`) above
  `CardPayment { IsBusinessCard: true } c` and read error CS8510 — the two arms below it are now
  unreachable. Move it back.
- Delete the `_ =>` arm in `Fee` and read warning CS8509 ("the switch expression does not handle all
  possible values"). Then add `public sealed record CryptoPayment(decimal Amount) : Payment(Amount);` to
  `Payment.cs` and this test to the `FeeCalculatorTests` class in `PaymentTests.cs`:
  `[Fact] public void Unknown_payment_type_is_rejected() => Assert.Throws<NotSupportedException>(() => FeeCalculator.Fee(new CryptoPayment(5m)));`
  It fails: `Assert.Throws` reports that a `System.Runtime.CompilerServices.SwitchExpressionException`
  was thrown instead. Restore the `_` arm and the test passes — now the `_` arm's
  `NotSupportedException` is what comes out.
- Add an extension property `public string Last4 => value is { Length: >= 4 } ? value[^4..] : value ?? "";`
  to the `extension(string? value)` block and add a test:
  `Assert.Equal("3000", "DE89370400440532013000".Last4);`.

- [ ] All 14 tests pass (15 if you kept the `CryptoPayment` test)
- [ ] I triggered CS8510 by reordering arms and fixed it
- [ ] I saw `SwitchExpressionException` at runtime when no switch arm matched
- [ ] I can explain why `ReceiptService` takes an `INotifier` instead of inheriting from a notifier class
:::

## Flashcards

:::cards id=be-02-cards1 title="Modern C#"
Q: `abstract` vs `virtual` member?
A: `abstract`: no body, subclasses **must** override. `virtual`: has a default, subclasses **may** override.
Q: Why prefer composition over inheritance?
A: Composition (injecting collaborators) keeps classes small, testable and loosely coupled. Inheritance chains are rigid: base-class changes ripple everywhere.
Q: Class vs record primary constructor parameters?
A: Record: become public init-only properties. Class: just captured (mutable) parameters, no property.
Q: How are switch expression arms evaluated?
A: Top to bottom, first match wins. Unreachable arms are a compile error (CS8510); a missing match at runtime throws `SwitchExpressionException`.
Q: What does `x is { Length: > 3 }` check?
A: `x` is non-null **and** its `Length` is greater than 3.
Q: What do C# 14 extension blocks add?
A: Extension **properties** and **static** extension members (`extension(T receiver) { … }`), not only extension methods.
Q: What's a generic constraint for?
A: Restricting `T` (`where T : IComparable<T>`) so you can call members of `T` safely.
Q: `throw;` vs `throw ex;`?
A: `throw;` rethrows preserving the original stack trace; `throw ex;` resets it.
Q: Exception filter syntax?
A: `catch (SomeException ex) when (condition)` — the catch only runs if the condition is true.
Q: When should you NOT throw?
A: For expected outcomes (not found, invalid input, duplicates). Return a result and map it to a status code.
Q: `Func<int, string>` vs `Action<int>`?
A: Both are delegate types for a method taking an `int`. `Func`'s **last** type argument is the return type (`string`); `Action` returns nothing.
Q: How does `System.Text.Json` write an enum by default, and how do you change it?
A: As its number. Add `JsonStringEnumConverter` to the serializer options to write names instead. Persisted enums need stable, explicit values or string storage.
:::

## Recap

- **Interfaces** are nominal contracts; use them at boundaries (email, payments, clock, HTTP) and for
  testability — not for every class.
- Prefer **composition** (inject collaborators) over inheritance; inherit mostly from framework
  types. Methods aren't virtual by default; seal classes not designed for inheritance.
- **Primary constructors** remove DI boilerplate; on classes they're parameters, on records they're properties.
- **Collection expressions** `[a, .. b]` create any collection type; the target type decides.
- **Pattern matching** (`is`, property/relational/list patterns) and **switch expressions** replace
  `if` chains. First matching arm wins; add `_` for exhaustiveness.
- **Extension methods** add methods to types you don't own; **C# 14 extension blocks** add properties
  and static members too.
- **Generics** are reified and type-safe; constraints unlock members of `T`.
- **Delegates** (`Func`, `Action`) make functions values; lambdas are closures over variables.
  **Events** are delegates with `+=`/`-=` (unsubscribe, or leak). **Enums** are named integers:
  serialize them as strings and never renumber persisted ones.
- **Exceptions** are for the unexpected: `throw;` to rethrow, filters with `when`, `using` for cleanup,
  results for expected failures.
