---
id: be-23
title: C# Syntax Primer
level: beginner
minutes: 75
xp: 100
summary: Your first hour of C# from zero — file shape, semicolons and braces, types and strings, operators, if/switch, loops, methods, classes, lists, null, compiler errors and dotnet run, each compared with JavaScript.
---

Every backend lesson after this one is written in **C#** (say "C sharp"), the main language of
.NET. If you have never written C# before, the code in *C# Essentials for JS/TS Developers* can look
like a wall of braces and keywords. This lesson removes that wall: it walks through the **syntax**
(the spelling and grammar rules of a language) piece by piece, with a tiny example for every idea
and a comparison with JavaScript, which you probably know from the frontend.

You don't need to memorise anything. The goal is that when you see a line of C#, you can say what
each part is and what it does.

## Why syntax first?

A **compiler** is a program that reads your source code and turns it into something the computer
can run. C# is a **compiled** language: before your program runs at all, the C# compiler checks
every line. If one semicolon is missing or a text value is put where a number belongs, nothing runs —
you get a **compiler error** instead.

JavaScript is different: the browser starts running your file and only complains when it reaches the
broken line (or never complains and does something surprising). That makes C# feel strict at first,
but the strictness is the point — whole categories of bugs are caught on your machine before a
customer ever sees them. Knowing the syntax rules means you spend your time on logic, not on fighting
red squiggles.

## How C# code runs

```text
Program.cs  ──(C# compiler)──▶  app.dll  ──(.NET runtime)──▶  your program runs
```

- **Source code**: the `.cs` text files you write.
- **Build / compile**: `dotnet build` checks and translates them into a `.dll` file (compiled code).
- **Runtime**: the .NET runtime loads that `.dll` and executes it.
- `dotnet run` does build + run in one step — that's the command you'll use most.

You'll do this for real in the lab further down. For now: **compile errors stop the build; nothing
runs until they are fixed.**

## The shape of a C# file

### Modern style: top-level statements

Since C# 9 the smallest complete program is one line in a file called `Program.cs`:

```csharp
Console.WriteLine("Hello, World!");
```

- `Console` is a **class** (a named bundle of code) provided by .NET for the terminal.
- `.WriteLine(...)` is a **method** (a function that belongs to a class) that prints text plus a
  line break. `Console.Write(...)` prints *without* the line break.
- `"Hello, World!"` is a **string** (a piece of text).
- `;` ends the **statement** (one instruction).

This style is called **top-level statements**: code written directly in the file, outside any class.
Only *one* file in a project may do this, and that file is where the program starts. It's what
`dotnet new console` generates and what ASP.NET Core's `Program.cs` uses.

JavaScript equivalent: `console.log("Hello, World!")`.

### Classic style: `Main` inside a class

You will meet this older shape in tutorials and existing codebases. It does exactly the same thing:

```csharp
using System;                          // 1. import a namespace

namespace HelloApp;                    // 2. which "folder" of names this code lives in

class Program                          // 3. a class
{
    static void Main(string[] args)    // 4. the entry point
    {
        Console.WriteLine("Hello from Main!");
    }
}
```

1. **`using`** makes the names in a **namespace** available without typing the full name. A
   namespace is a labelled group of related classes — `System` contains `Console`. Without the
   `using` you would write `System.Console.WriteLine(...)`. Like `import` in JS, but it imports a
   whole group of names at once. Modern projects turn on **implicit usings**, so common ones
   (`System`, `System.Collections.Generic`, `System.Linq`, …) are already there and you rarely see this line.
2. **`namespace HelloApp;`** puts everything in this file into the `HelloApp` namespace. The
   semicolon form is a **file-scoped namespace** (applies to the whole file). Older code wraps the
   file in `namespace HelloApp { ... }` instead — same meaning, one more level of indentation.
3. **`class Program`** — in C#, all code (other than top-level statements) must live inside a type,
   usually a class. There are no free-floating functions like in JS.
4. **`static void Main(string[] args)`** — the method .NET calls when the program starts.
   `static` = belongs to the class itself, no object needed; `void` = returns nothing;
   `string[] args` = the command-line arguments as an array of strings.

Top-level statements are just the compiler writing this boilerplate for you. Even the command-line
arguments are still there: in a top-level file you can read them through a ready-made variable called
`args`.

:::quiz id=be-23-q1 xp=10
In a classic (non top-level) C# program, where does execution start?
- [ ] At the first line of the file, like a JavaScript `<script>`
- [x] In the `static void Main` method
- [ ] In the constructor of the first class in the file
- [ ] In whichever method is named after the file
> .NET looks for a `static` method named `Main` and calls it — that is the **entry point**. Code is
> not executed just because it appears at the top of a file (classes and methods only *define*
> things). With top-level statements the compiler generates that `Main` for you around your code.
:::

## Statements, semicolons, braces and comments

- A **statement** is one instruction. In C# every simple statement **must** end with `;`. JavaScript
  inserts missing semicolons for you ("ASI"); C# never does.
- **Braces** `{ }` group statements into a **block** — the body of a class, method, `if` or loop.
  A variable declared inside a block only exists inside that block (its **scope**).
- **Whitespace and line breaks don't matter** to the compiler; indentation is for humans. By
  convention C# puts the opening `{` on its *own* line (JS usually keeps it on the same line).
- C# is **case-sensitive**: `console.writeline` is not `Console.WriteLine`.

```csharp
// A single-line comment: ignored by the compiler.

/* A multi-line comment,
   also ignored. */

int answer = 42;   // comments can follow code on the same line

/// <summary>An XML doc comment: three slashes, placed right above a method or class.
/// Your editor shows it as a tooltip wherever the method is used.</summary>
static int Double(int x) => x * 2;
```

:::quiz id=be-23-q2 xp=10
What happens when you build this?

```csharp
Console.WriteLine("Hi")
Console.WriteLine("there");
```
- [ ] It prints `Hi` and `there`, like JavaScript would
- [ ] It prints only `there`
- [x] The build fails with `error CS1002: ; expected` and nothing runs
- [ ] It prints `Hi` and crashes on the second line
> C# has no automatic semicolon insertion. The compiler reports **CS1002** pointing just after
> `("Hi")`, and because it's a *compile* error, no line runs at all — not even the first one. In JS
> both lines would print.
:::

## Variables and types

A **variable** is a named box that holds a value. A **type** says what kind of value fits in the box.
In C#, every variable has exactly one type, decided when you write the code, and it can never hold
anything else. This is **static typing** — like TypeScript, except the checks are real all the way
down (there is no "`any` and hope").

```csharp
int age = 36;              // whole numbers (32-bit): -2,147,483,648 … 2,147,483,647
long views = 9_000_000_000; // bigger whole numbers; _ is just a digit separator
double ratio = 0.75;       // floating-point numbers (fast, slightly imprecise)
decimal price = 19.99m;    // exact decimal numbers — use for money; note the m suffix
bool isAdmin = false;      // true or false
char grade = 'A';          // exactly ONE character, single quotes
string name = "Ada";       // text, double quotes
```

The pattern is always **`type name = value;`**. Compare with JS:

| JavaScript | C# |
|---|---|
| `let age = 36` | `int age = 36;` |
| `const PI = 3.14` | `const double Pi = 3.14;` |
| one `number` type for everything | `int`, `long`, `double`, `decimal`, … |
| `let x = 5; x = "five"` ✅ | `int x = 5; x = "five";` ❌ compile error |

### `var`: let the compiler figure out the type

```csharp
var city = "Oslo";   // city is a string — forever
var count = 3;       // count is an int
city = 42;           // ❌ error CS0029: Cannot implicitly convert type 'int' to 'string'
```

`var` is **not** JavaScript's `let` or `any`. The compiler looks at the value on the right, picks the
type, and the variable keeps that type. It saves typing; it doesn't make anything dynamic. Teams
usually use `var` when the type is obvious from the right-hand side.

A variable must be given a value before you read it. `int z; Console.WriteLine(z);` fails with
**CS0165: Use of unassigned local variable 'z'** — there is no `undefined` in C#.

:::quiz id=be-23-q3 xp=10
Which line does **not** compile?
- [ ] `var total = 10;`
- [ ] `string title = "Report";`
- [x] `int count = "5";`
- [ ] `decimal price = 4.50m;`
> `"5"` is a string, and C# never silently turns a string into an `int` — that's
> **CS0029: Cannot implicitly convert type 'string' to 'int'**. You have to convert on purpose,
> for example `int.Parse("5")`. JavaScript would happily store the string. `var total = 10;` is
> fine: `var` just means "infer `int` from the value".
:::

## Strings and characters

C# has several ways to write text. They exist because real code is full of file paths, JSON and
messages built from variables — each form makes one of those painless.

| Syntax | Name | What it is for |
|---|---|---|
| `"Hello"` | string literal | Normal text. Backslash starts an **escape**: `\n` new line, `\t` tab, `\"` a quote, `\\` a backslash. |
| `'H'` | char literal | **One** character (type `char`). Not a string! |
| `@"C:\temp\new"` | verbatim string | Backslashes are literal, can span lines. Great for Windows paths and regexes. `""` writes one quote. |
| `$"Hi {name}"` | interpolated string | Put expressions inside `{ }`. Like JS template literals `` `Hi ${name}` ``. |
| `"""…"""` | raw string literal | Quotes and backslashes need no escaping — perfect for JSON, SQL, HTML. |

```csharp
string name = "Ada";
Console.WriteLine($"Hi {name}, {name.Length} letters");   // Hi Ada, 3 letters
Console.WriteLine($"Pi is about {3.14159:F2}");           // Pi is about 3.14  (:F2 = 2 decimals)
Console.WriteLine($"{{braces}} need doubling");           // {braces} need doubling

string json = """
    { "name": "Ada", "path": "C:\temp" }
    """;
Console.WriteLine(json);   // { "name": "Ada", "path": "C:\temp" }
```

In a raw string the indentation of the closing `"""` is removed from every line, so you can indent
it nicely in your code.

To interpolate into a raw string that itself contains `{ }` (like JSON), put **two** `$` in front.
Then a *double* brace `{{…}}` is an interpolation hole and a single `{` is just a character:

```csharp
Console.WriteLine($$"""{ "name": "{{name}}" }""");   // { "name": "Ada" }
```

With only one `$`, the JSON's own `{` would be read as the start of a hole and the build fails
(**CS8076**).

:::warn title="Single quotes are not strings in C#"
In JavaScript `'hi'` and `"hi"` are the same. In C#, `'h'` is a `char` and `'hi'` is a compile
error (**CS1012: Too many characters in character literal**). Use double quotes for text.
:::

:::tip title="Number formatting depends on the machine's culture"
`Console.WriteLine(3.5)` prints `3.5` on an English system but `3,5` on a German one, because .NET
formats numbers using the current **culture** (language/region settings). The same goes for
`{3.14159:F2}` (`3.14` vs `3,14`). Output examples in this lesson use English formatting.
:::

:::quiz id=be-23-q4 xp=10
What does this print?

```csharp
Console.WriteLine("C:\temp\new");
```
- [ ] `C:\temp\new`
- [x] `C:`, a tab, `emp`, then `ew` on the next line
- [ ] A compile error because of the backslashes
- [ ] `C:\\temp\\new`
> In a normal string `\t` is an escape for a **tab** and `\n` for a **new line**, so the path gets
> mangled. Write `@"C:\temp\new"` (verbatim) or `"C:\\temp\\new"` (escaped backslashes) to get the
> literal path. JavaScript has the same escapes but no `@` form.
:::

## Operators

An **operator** is a symbol that computes a value from one or more **operands**: `a + b`. A piece of
code that produces a value (`a + b`, `age >= 18`, `"Hi " + name`) is called an **expression**; a
statement often *contains* expressions (`int sum = a + b;`).

| Kind | Operators | Notes |
|---|---|---|
| Arithmetic | `+ - * / %` | `%` = remainder: `7 % 3` is `1` |
| Assignment | `= += -= *= /=` `++ --` | `x += 2` means `x = x + 2` |
| Comparison | `== != < > <= >=` | result is a `bool` |
| Logical | `&& \|\| !` | and, or, not — only work on `bool` |
| Null | `??` `?.` | see "null and ?" below |

Three differences from JavaScript that bite beginners:

1. **Integer division.** If both sides are integers, `/` throws away the fraction:
   `7 / 2` is `3`. Make one side a floating-point number to get `3.5`: `7 / 2.0`.
2. **There is no `===`.** C# `==` never converts types (comparing an `int` with a `string` doesn't
   even compile), and for strings it compares the **text**: `"hi" == "h" + "i"` is `true`.
3. **No truthiness.** `if (count)` doesn't compile when `count` is an `int`; write `if (count > 0)`.
   Only `bool` values can be conditions.

`+` with a string concatenates, evaluated left to right: `1 + 2 + "3"` is `"33"` (first `1 + 2 = 3`,
then `3 + "3"`), and `"1" + 2 + 3` is `"123"`.

One small surprise when printing: `Console.WriteLine(true)` prints **`True`** with a capital T
(JavaScript's `console.log(true)` prints `true`). The value is the same; only its text form differs.

:::quiz id=be-23-q13 xp=10
What does this print?

```csharp
Console.WriteLine(1 + 2 + "3" + 1 + 2);
```
- [ ] `9`
- [ ] `336`
- [x] `3312`
- [ ] A compile error: you can't add numbers and strings
> `+` is evaluated left to right. `1 + 2` is the number `3`; `3 + "3"` is the string `"33"`; from then
> on every `+` is string concatenation: `"33" + 1` is `"331"`, then `"3312"`. JavaScript gives the
> same answer here.
:::

:::quiz id=be-23-q5 xp=10
What does this print?

```csharp
int apples = 7;
int people = 2;
Console.WriteLine(apples / people);
```
- [ ] `3.5`
- [x] `3`
- [ ] `4`
- [ ] A compile error: you must use `double` for division
> Both operands are `int`, so C# does **integer division** and truncates toward zero: `3`. In
> JavaScript `7 / 2` is `3.5` because every number is a floating-point `number`. To get `3.5` here,
> write `(double)apples / people` — the `(double)` is a **cast**, an explicit conversion.
:::

:::quiz id=be-23-q6 xp=10
What does this print?

```csharp
Console.WriteLine('a' + 1);
```
- [ ] `a1`
- [ ] `b`
- [x] `98`
- [ ] A compile error
> `'a'` is a `char`, not a string. A `char` is stored as a number (its Unicode code, 97 for `a`), and
> `char + int` is arithmetic, giving the `int` `98`. With double quotes, `"a" + 1` concatenates to
> `"a1"` — which is also what JavaScript gives for `'a' + 1`.
:::

## Making decisions: `if` and `switch`

### `if` / `else if` / `else`

```csharp
int temperature = 18;

if (temperature > 25)
{
    Console.WriteLine("Hot");
}
else if (temperature > 15)
{
    Console.WriteLine("Mild");      // ← this runs
}
else
{
    Console.WriteLine("Cold");
}
```

The condition goes in parentheses and **must be a `bool`**. Braces are optional for a single
statement, but most teams require them — it prevents the classic bug of adding a second line that
silently isn't part of the `if`.

The **ternary operator** picks one of two values: `string label = age >= 18 ? "adult" : "minor";` —
same as JS.

### `switch` statement

When you compare one value against many options:

```csharp
string command = "stop";

switch (command)
{
    case "start":
        Console.WriteLine("Starting");
        break;
    case "stop":
    case "halt":                      // several labels can share one body
        Console.WriteLine("Stopping");
        break;
    default:
        Console.WriteLine("Unknown");
        break;
}
```

Unlike JS, C# **does not let one case fall through** into the next — every non-empty case must end
with `break` (or `return`). Forgetting it is a compile error, not a silent bug.

### `switch` expression (modern, and very common)

When you want to *compute a value*, the switch **expression** is shorter. Each arm is
`pattern => result`, arms are separated by commas, and `_` means "anything else":

```csharp
int day = 6;
string kind = day switch
{
    6 or 7 => "weekend",
    >= 1 and <= 5 => "weekday",
    _ => "invalid",
};
```

The patterns `6 or 7`, `>= 1 and <= 5` are **pattern matching** — you'll see much more of it in
*Modern C# — Interfaces, Patterns & C# 14*.

:::quiz id=be-23-q7 xp=10
What is `size` after this runs?

```csharp
int score = 75;
string size = score switch
{
    >= 90 => "large",
    >= 70 => "medium",
    >= 50 => "small",
    _ => "none",
};
```
- [ ] `"large"`
- [x] `"medium"`
- [ ] `"small"`
- [ ] It doesn't compile: 75 matches two arms
> Arms are tried **top to bottom** and the first matching one wins. `75 >= 90` is false,
> `75 >= 70` is true → `"medium"`. Matching more than one arm is fine; the compiler only complains if
> an arm can *never* be reached (for example `>= 50` placed above `>= 70`).
:::

## Loops

A **loop** repeats a block. C# has the same four loops as JavaScript, with C# spelling:

```csharp
// for: when you need a counter
for (int i = 0; i < 3; i++)
{
    Console.Write(i);          // 012
}

// foreach: walk every item of a collection (JS: for...of)
string[] fruits = ["apple", "pear"];
foreach (string fruit in fruits)
{
    Console.WriteLine(fruit);
}

// while: repeat while a condition is true (checked BEFORE each round)
int n = 1;
while (n < 100) { n *= 2; }    // n ends at 128

// do-while: like while, but the body always runs at least once
int tries = 0;
do { tries++; } while (tries < 3);
```

Inside any loop, `break` leaves the loop and `continue` jumps to the next round. Note it's
`foreach (… in …)` — **`in`**, not JavaScript's `of`. (JS's `for...in` loops over *keys*; C#'s
`foreach...in` loops over *values*.)

`i++` means "add 1 to `i`". Used inside an expression, `i++` gives the **old** value and then
increments; `++i` increments first.

:::quiz id=be-23-q8 xp=10
What does this print?

```csharp
foreach (string w in new[] { "a", "b", "c", "d" })
{
    if (w == "c") break;
    if (w == "a") continue;
    Console.Write(w);
}
```
- [ ] `abc`
- [ ] `bcd`
- [x] `b`
- [ ] `bd`
> `"a"` hits `continue`, so it's skipped. `"b"` is printed. `"c"` hits `break`, which ends the
> whole loop, so `"d"` is never visited. Result: `b`.
:::

## Methods

A **method** is a named, reusable block of code — C#'s word for a function. Its **signature** spells
out everything about it:

```csharp
//  return type   name    parameters (type name, ...)
static int        Add    (int a, int b)
{
    return a + b;
}

static void SayHi(string name)        // void = returns nothing
{
    Console.WriteLine($"Hi {name}");
}

static string Shout(string text) => text.ToUpper() + "!";   // expression-bodied: one expression, no braces/return

static string Greet(string name, string greeting = "Hello") // optional parameter with a default
    => $"{greeting}, {name}";

Console.WriteLine(Add(2, 3));          // 5
SayHi("Ada");                          // Hi Ada
Console.WriteLine(Shout("hey"));       // HEY!
Console.WriteLine(Greet("Ada"));       // Hello, Ada
Console.WriteLine(Greet("Ada", greeting: "Welcome"));  // named argument
```

- **Parameters** are the variables in the definition (`int a, int b`); **arguments** are the
  values you pass in a call (`2, 3`).
- Every parameter has a type, and the **return type** comes *before* the name (TS puts it after:
  `function add(a: number, b: number): number`).
- A non-`void` method must `return` a value on every path, or you get **CS0161: not all code paths
  return a value**.
- In a top-level-statement file, helper methods like these are **local functions**: they can be
  called before or after the line that defines them (like JS function declarations). Marking them
  `static` stops them from accidentally using outer variables. Classes, though, must come **after**
  all top-level statements, at the end of the file.

:::quiz id=be-23-q9 xp=10
Which method signature describes "takes a name and a count, and returns nothing"?
- [ ] `string Repeat(string name, int count)`
- [x] `void Repeat(string name, int count)`
- [ ] `Repeat(name: string, count: int): void`
- [ ] `void Repeat(name, count)`
> In C# the return type comes first, and `void` means "no return value". Each parameter is written
> `type name`. Option 3 is TypeScript syntax, and option 4 leaves out the parameter types, which C#
> requires.
:::

## Classes, objects and properties at a glance

A **class** is a blueprint; an **object** (or **instance**) is one thing built from it with `new`.
A **property** is a named value on an object, with a `get` (read) and usually a `set` (write).

```csharp
var ada = new Person { Name = "Ada", Age = 36 };   // create an object, set properties
ada.Age = 37;                                        // change one
Console.WriteLine(ada.Describe());                   // Ada (37)

class Person
{
    public string Name { get; set; } = "";   // property with a default value
    public int Age { get; set; }

    public string Describe() => $"{Name} ({Age})";   // a method on each Person
}
```

- `public` is an **access modifier**: code outside the class may use this member. `private` (the
  default) hides it.
- `{ get; set; }` is an **auto-property** — C# creates the hidden storage for you.
- `{ Name = "Ada", Age = 36 }` after `new Person` is an **object initializer**.

For simple data, a one-line **record** gives you a class with properties, a constructor and
value-based equality: `record Point(int X, int Y);` then `var p = new Point(1, 2);`. Value types,
records and structs are explained properly in *C# Essentials for JS/TS Developers*.

JS comparison: `{ name: "Ada", age: 36 }` creates an object without any class. In C# every object has
a class (a type), so the compiler knows exactly which properties exist — typos like `ada.Nmae` are
compile errors.

## Collections preview: arrays and `List<T>`

```csharp
int[] scores = [72, 95, 58];         // array: fixed size
Console.WriteLine(scores[0]);         // 72  (indexes start at 0)
Console.WriteLine(scores.Length);     // 3

List<string> langs = ["C#", "TS"];    // List: grows and shrinks
langs.Add("SQL");
langs.Remove("TS");
Console.WriteLine(langs.Count);       // 2
Console.WriteLine(string.Join(", ", langs));  // C#, SQL

Dictionary<string, int> ages = new() { ["Ada"] = 36 };  // key → value lookup
Console.WriteLine(ages["Ada"]);       // 36
```

- `int[]` = "array of `int`". Its size is fixed once created.
- `List<string>` = "list of `string`". The `<T>` part is a **generic type parameter**: `List<T>` is
  one class that works for any item type `T`, and the compiler makes sure only that type goes in.
  It's the closest thing to a JS array.
- `[ ... ]` is a **collection expression** (C# 12+). Older code writes `new List<string> { "C#", "TS" }`
  or `new int[] { 72, 95, 58 }`.
- Watch the naming: arrays have `.Length`, lists have `.Count`.

Much more in *Collections & LINQ*.

:::quiz id=be-23-q10 xp=10
Which statements about this code are true? (Select all that apply.)

```csharp
List<int> ids = [1, 2];
ids.Add(3);
```
- [x] `ids.Count` is now `3`
- [ ] `ids.Add("4")` would also work, like in JavaScript
- [x] `ids[0]` is `1`
- [ ] `ids.Length` is `3`
> A `List<int>` can only hold `int`s — adding a string is a compile error. After `Add(3)` the list
> holds `1, 2, 3`, so `Count` is 3 and index 0 is `1`. Lists use `.Count`; `.Length` is the array
> property and doesn't exist on `List<T>`.
:::

## `null` and `?`

**`null`** means "no object here". C# has no separate `undefined` — just `null`. A `?` after a type
says "this may also be `null`":

```csharp
int? maybeAge = null;        // nullable value type: an int OR null
string? nickname = null;     // nullable reference type: a string OR null
string name = "Ada";         // non-nullable: the compiler warns if you might put null here

int length = nickname?.Length ?? 0;              // 0
string shown = nickname ?? "stranger";           // "stranger"
nickname ??= "Ace";                              // assign only if currently null
```

- `?.` (**null-conditional**): if the left side is `null`, stop and give `null` instead of crashing.
  Same as JS optional chaining.
- `??` (**null-coalescing**): "use the left value, unless it's `null`, then use the right". Same as JS.
- Calling a member on `null` without `?.` throws a **`NullReferenceException`** at runtime — C#'s
  version of "Cannot read properties of null".

Modern projects turn on **nullable reference types** (`<Nullable>enable</Nullable>` in the project
file), so the compiler *warns* (CS8600, CS8602, …) wherever a `null` could sneak into a variable
declared without `?`. Treat those warnings as bugs waiting to happen.

:::quiz id=be-23-q11 xp=10
What does this print?

```csharp
string? city = null;
Console.WriteLine(city?.Length ?? -1);
```
- [ ] `0`
- [ ] Nothing — it throws `NullReferenceException`
- [x] `-1`
- [ ] An empty line
> `city?.Length` sees that `city` is `null` and short-circuits to `null` instead of throwing. Then
> `?? -1` replaces that `null` with `-1`. Without the `?.`, `city.Length` would throw a
> `NullReferenceException` at runtime.
:::

## Practice the concepts in TypeScript

The browser can't compile C#, so these two challenges use TypeScript to practise the same ideas you
just met. Read the C# version first, then write the TS twin.

:::challenge id=be-23-c1 lang=ts xp=25
title: A switch expression, the TypeScript way
This C# method turns a score into a letter grade:

```csharp
static string Grade(int score) => score switch
{
    >= 90 => "A",
    >= 75 => "B",
    >= 60 => "C",
    _ => "F",
};
```

Write `grade(score)` in TypeScript with the **same** result for every score: 90 and up → `"A"`,
75–89 → `"B"`, 60–74 → `"C"`, everything else → `"F"`.

hint: TypeScript has no switch expression with relational patterns — an `if` / `else if` chain, checked top to bottom, does the same job.
hint: Check the highest boundary first: `if (score >= 90) return 'A'`.

```ts starter
export function grade(score: number): string {
  return 'F'
}
```

```ts solution
export function grade(score: number): string {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  return 'F'
}
```

```ts tests
test('90 and above is A', () => {
  expect(grade(90)).toBe('A')
  expect(grade(100)).toBe('A')
})
test('75 to 89 is B', () => {
  expect(grade(75)).toBe('B')
  expect(grade(89)).toBe('B')
})
test('60 to 74 is C', () => {
  expect(grade(60)).toBe('C')
  expect(grade(74)).toBe('C')
})
test('below 60 is F', () => {
  expect(grade(59)).toBe('F')
  expect(grade(0)).toBe('F')
})
```
:::

:::challenge id=be-23-c2 lang=ts xp=25
title: Loops, integer division and `??`
This C# method averages a list of scores and greets an optional nickname:

```csharp
static string Summary(int[] scores, string? nickname)
{
    int total = 0;
    foreach (int s in scores)
    {
        total += s;
    }
    int average = scores.Length == 0 ? 0 : total / scores.Length;  // integer division!
    return $"{nickname ?? "stranger"}: {average}";
}
```

Write `summary(scores, nickname)` in TypeScript that returns exactly the same text:
`"<name>: <average>"`, for example `"Ada: 78"`.

- `<name>` is `nickname`, or `"stranger"` when `nickname` is `null` or `undefined` (left out).
- `<average>` is the sum divided by the count **without the fraction**, like C# `int / int`
  (`313 / 4` is `78`, not `78.25`).
- An empty list has average `0`.

hint: Loop with `for (const s of scores) total += s` — TS's `for...of` is C#'s `foreach...in`.
hint: JS division keeps the fraction; `Math.trunc(total / scores.length)` mimics C# integer division.
hint: `nickname ?? 'stranger'` works the same in TypeScript.

```ts starter
export function summary(scores: number[], nickname?: string | null): string {
  let total = 0
  return `${nickname}: ${total}`
}
```

```ts solution
export function summary(scores: number[], nickname?: string | null): string {
  let total = 0
  for (const s of scores) {
    total += s
  }
  const average = scores.length === 0 ? 0 : Math.trunc(total / scores.length)
  return `${nickname ?? 'stranger'}: ${average}`
}
```

```ts tests
test('uses the nickname and integer average', () => {
  expect(summary([72, 95, 58, 88], 'Ada')).toBe('Ada: 78')
})
test('falls back to "stranger" for null', () => {
  expect(summary([10, 20], null)).toBe('stranger: 15')
})
test('falls back to "stranger" when missing', () => {
  expect(summary([1, 2])).toBe('stranger: 1')
})
test('empty list averages to 0', () => {
  expect(summary([], 'Bo')).toBe('Bo: 0')
})
```
:::

## Reading compiler errors

Compiler errors look scary but they all have the same shape, and once you can read it most fixes take
seconds:

```text
Program.cs(3,24): error CS1002: ; expected
│          │  │   │     │       └─ the message: what the compiler wanted
│          │  │   │     └─ the error code: search it (e.g. "CS1002") for the official docs page
│          │  │   └─ severity: error (build fails) or warning (build succeeds)
│          │  └─ column
│          └─ line
└─ file
```

The three you will meet in your first week:

| Code | Message | Usual cause | Fix |
|---|---|---|---|
| **CS1002** | `; expected` | Missing semicolon at the end of a statement. | Add the `;` at the reported position (often the end of the line *above* where you were looking). |
| **CS0103** | `The name 'x' does not exist in the current context` | A typo (`nmae`), wrong capitalisation, a missing `using`, or using a variable outside the block `{ }` where it was declared. | Fix the spelling, add the `using`, or declare the variable in the outer scope. |
| **CS0029** | `Cannot implicitly convert type 'string' to 'int'` | Putting a value of one type into a variable of another. | Convert on purpose (`int.Parse(text)`, `number.ToString()`) or fix the variable's type. |

```csharp
if (true)
{
    int inner = 1;
}
Console.WriteLine(inner);   // CS0103: 'inner' only exists inside the braces above
```

:::tip title="Fix the first error first"
One missing brace can produce twenty errors further down the file, because the compiler loses track
of where blocks start and end. Always fix the **first** error in the list, rebuild, then look again.
:::

:::quiz id=be-23-q12 xp=10
You get `Program.cs(12,9): error CS0103: The name 'totl' does not exist in the current context`.
What is the most likely cause?
- [ ] A missing semicolon on line 12
- [x] A typo: the variable is called `total`, but line 12 says `totl`
- [ ] Line 12 assigns a string to an `int`
- [ ] The program crashed at runtime on line 12
> **CS0103** means the compiler can't find anything with that name in the current scope — almost
> always a typo, wrong capitalisation, a missing `using`, or a variable declared inside another
> block. A missing semicolon is CS1002, a type mismatch is CS0029, and compiler errors happen at
> build time, not at runtime.
:::

## Running C# code

You need the **.NET SDK** (software development kit — the compiler plus the `dotnet` command).
Install .NET 10 from the official download page or your package manager, then check it:

```bash
dotnet --version            # e.g. 10.0.100 or newer
```

The loop you'll use every day:

```bash
dotnet new console -o HelloCsharp   # create a project in a new folder from the "console" template
cd HelloCsharp
dotnet run                          # build + run
dotnet watch                        # rebuild and rerun automatically on every save
```

`dotnet new console` creates two important files:

- `Program.cs` — your code (top-level statements: `Console.WriteLine("Hello, World!");`).
- `HelloCsharp.csproj` — the **project file**: XML that tells the SDK what to build. The lines
  `<TargetFramework>net10.0</TargetFramework>` (which .NET version), `<ImplicitUsings>enable</ImplicitUsings>`
  and `<Nullable>enable</Nullable>` explain the features you met above. *The .NET CLI, Solutions &
  Projects* covers it in depth.

`bin/` and `obj/` folders appear after the first build — they are generated output, never edit or
commit them.

:::job title="What day one looks like"
On a .NET team you'll clone a repo, run `dotnet build` and `dotnet test`, and open the solution in
Visual Studio, JetBrains Rider or VS Code with the C# Dev Kit. Nobody expects you to know every
keyword — they expect you to read a compiler error, find the line, and fix it without panicking.
Keep the error codes you meet in your notes; the same handful come back constantly.
:::

:::pro title="How seniors write C# syntax"
Experienced developers lean on the tooling: they let the IDE add missing `using`s, rename variables
everywhere at once, and format the file on save (`dotnet format` does the same from the command
line). They keep nullable warnings at zero, often by setting `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`
in the project file — so a possible `null` is a build failure, not a 3 a.m. `NullReferenceException`.
:::

:::lab id=be-23-lab1 xp=40
title: Your first console app and the edit–run loop
Build a tiny grade book, break it on purpose, and fix it.

**1. Create the project**

```bash
dotnet new console -o GradeBook
cd GradeBook
dotnet run
```

Expected output:

```text
Hello, World!
```

**2. Replace `Program.cs`** with this complete file:

```csharp
// Program.cs - a tiny grade book
string course = "C# Primer";
int[] scores = [72, 95, 58, 88];

Console.WriteLine($"Course: {course}");
Console.WriteLine($"Students: {scores.Length}");

int total = 0;
foreach (int score in scores)
{
    total += score;
    Console.WriteLine($"{score,3} -> {Grade(score)}");
}

int average = total / scores.Length;
Console.WriteLine($"Average: {average} ({Grade(average)})");

string? nickname = null;
Console.WriteLine($"Well done, {nickname ?? "stranger"}!");

static string Grade(int score) => score switch
{
    >= 90 => "A",
    >= 75 => "B",
    >= 60 => "C",
    _ => "F",
};
```

`{score,3}` pads the number to 3 characters wide, so the column lines up.

**3. Run it:**

```bash
dotnet run
```

Expected output:

```text
Course: C# Primer
Students: 4
 72 -> C
 95 -> A
 58 -> F
 88 -> B
Average: 78 (B)
Well done, stranger!
```

The average is `78`, not `78.25` — integer division (`313 / 4`).

**4. Break it on purpose.** Delete the `;` at the end of the line
`Console.WriteLine($"Students: {scores.Length}");` (line 6) and run `dotnet run` again. You should
see an error like:

```text
Program.cs(6,48): error CS1002: ; expected
```

Line 6, column 48 is exactly where the missing `;` belongs.

:::warn title="Your error text may differ slightly"
The compiler sometimes *guesses* what you meant. Remove the `;` after `int total = 0` instead and
you get **CS1003: Syntax error, ',' expected**, because the compiler thinks you are declaring a second
variable on the same line. Also, on a non-English system the messages are translated (the `CS` code
stays the same — set `DOTNET_CLI_UI_LANGUAGE=en` for English). The full list of codes is in the
[C# compiler messages docs](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/).
:::

Put the semicolon back. Then change `int total = 0;` to `int total = "0";` and run again — you'll get
**CS0029**. Change it back. Finally rename `total` to `totl` in the `total += score;` line only — you'll
get **CS0103**. Fix it.

**5. Use the watch loop.** Start `dotnet watch` and leave it running. Change the nickname line to
`string? nickname = "Ada";` and save. The program rebuilds and reruns by itself; the last line now
reads `Well done, Ada!`. Stop it with `Ctrl + C`.

:::tip
If `dotnet` is "command not found", the SDK isn't installed or not on your `PATH`. Open a new
terminal after installing, then retry `dotnet --version`.
:::

- [ ] `dotnet run` printed `Hello, World!` for the new project
- [ ] The grade book printed exactly the expected output, including `Average: 78 (B)`
- [ ] I saw CS1002, CS0029 and CS0103 by breaking the code, and fixed each one
- [ ] With `dotnet watch` running, saving the file reran the program and printed `Well done, Ada!`
:::

:::cards id=be-23-cards1 xp=15 title="C# syntax basics"
Q: What ends every simple statement in C#?
A: A semicolon `;`. C# never inserts it for you (error CS1002 if missing).
Q: `'x'` vs `"x"`?
A: `'x'` is a `char` (one character); `"x"` is a `string`. Text always uses double quotes.
Q: What does `var` do?
A: The compiler infers the type from the value, and the variable keeps that type forever. It is not dynamic.
Q: What is `7 / 2` in C#?
A: `3` — integer division when both sides are `int`. Use `7 / 2.0` or a `(double)` cast for `3.5`.
Q: Name the four string forms besides plain `"text"`.
A: `'c'` char, `@"C:\path"` verbatim, `$"Hi {name}"` interpolated, `"""…"""` raw string literal.
Q: What does `void` mean in a method signature?
A: The method returns no value.
Q: `foreach` loops in C# use which keyword between the variable and the collection?
A: `in` — `foreach (var x in items)`. (JS uses `of`.)
Q: Array size vs list size?
A: `array.Length` (fixed size) vs `list.Count` (`List<T>` grows and shrinks).
Q: What do `?.` and `??` do?
A: `a?.B` gives null instead of throwing when `a` is null; `a ?? b` uses `b` when `a` is null.
Q: CS0103, CS1002, CS0029?
A: Name doesn't exist (typo/scope) · `;` expected · cannot convert one type to another.
Q: Which command builds and runs a project? Which reruns on save?
A: `dotnet run`; `dotnet watch`.
:::

## Recap

- C# is compiled: `dotnet build` checks every line first, and any compile error stops the program
  from running at all. `dotnet run` builds and runs, and `dotnet watch` reruns on every save.
- A file is `using`s, an optional `namespace`, and classes. Modern apps start with **top-level
  statements** in `Program.cs`, and older ones with `static void Main` inside a class.
- Statements end with `;`, blocks use `{ }`, and comments are `//`, `/* */` and `///`. Case matters.
- Every variable has one fixed type (`int`, `double`, `decimal`, `bool`, `char`, `string`). `var`
  infers that type but never makes the variable dynamic.
- Strings use `"…"`, chars use `'…'`. `@` makes a string verbatim, `$` interpolates and `"""` makes
  it raw.
- `int / int` truncates. `==` compares string text, there's no `===`, and conditions must be `bool`.
- `if`, `switch` (no fall-through) and the `switch` expression (`x switch { … => …, _ => … }`) make
  decisions, while `for`, `foreach…in`, `while` and `do…while` repeat code.
- Methods are written `returnType Name(type param)`, and `void` means they return nothing. Classes
  have properties `{ get; set; }` and you create objects with `new`.
- `T[]` arrays have a fixed size (`.Length`), `List<T>` grows (`.Count`), and `Dictionary<K,V>` looks
  up values by key.
- `?` on a type allows `null`, `?.` short-circuits when something is null, and `??` supplies a
  fallback.
- To read an error, start from file(line,col) and the code. **CS1002** means a missing `;`,
  **CS0103** an unknown name and **CS0029** the wrong type. Fix the first error first.
