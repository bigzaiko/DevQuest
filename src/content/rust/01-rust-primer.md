---
id: rs-01
title: Rust for TypeScript and C# developers
level: beginner
minutes: 110
xp: 120
summary: Why desktop shells like Tauri are written in Rust, the cargo toolchain, and the core language (let/mut, types, structs, enums, match, Option and Result with ?), shown next to TypeScript and C#.
---

Welcome to the Crab Forge. This region takes you from your first `cargo new` to a **Tauri 2**
desktop app that also runs on Android and iOS, ships signed installers and updates itself. Tauri
apps have a web frontend (your React skills carry over unchanged) and a **Rust** core. You do not
need to be a Rust expert to build one, but you do need to *read* Rust comfortably. Commands,
plugins, error messages and the security config all assume it.

This lesson gives you that reading level. It compares every idea with something you already know
from TypeScript or C#. Ownership and borrowing, the part of Rust that really is new, get their own
lesson next: **Ownership, borrowing and lifetimes**.

**What we use across the region**

| Piece | Version / command |
|---|---|
| Rust | stable via `rustup` (`rustc --version` → `1.85` or newer), **edition 2024** |
| Build tool | `cargo` (ships with Rust) |
| Desktop shell | **Tauri 2** (`@tauri-apps/cli` 2.x, `tauri` crate 2.x) |
| Frontend | React 19 + Vite 8 + TypeScript, as in the rest of DevQuest |
| Running example | **ClipDesk**, a small desktop tool for trimming and organising video clips |

## Why Rust?

Every program has to answer one question: **who frees the memory, and when?** There have been three
big answers.

```text
 Manual (C, C++)           Garbage collector (JS, C#, Java, Go)    Ownership (Rust)
 ─────────────────         ────────────────────────────────────    ─────────────────────────
 you call free()           a runtime finds unused objects          the compiler inserts the
                           and frees them later                    free at the end of scope
 + fast, no runtime        + safe and easy                         + fast, no runtime
 - use-after-free,         - pauses, extra memory, a runtime       + safe: checked at compile
   double free, leaks        to ship and start                       time
 - ~70% of serious         - still has data races                  - you learn the rules
   security bugs at big                                              (the borrow checker)
   vendors are memory bugs
```

Rust's answer is **ownership**: every value has exactly one owner, and the compiler frees the value
when the owner goes out of scope. Code that could use freed memory, free something twice, or write
to the same data from two threads at once **does not compile**. You get C-like speed and no garbage
collector, and a whole class of security bugs disappears before the program ever runs.

### Why desktop shells use it

A desktop app shell is a demanding place for code. It parses files from the internet, talks to the
operating system, runs for hours, and a crash or memory bug there can expose the whole machine.
**Tauri** puts a Rust core under a normal web UI:

```text
┌──────────────────── ClipDesk (one process tree) ─────────────────────┐
│                                                                       │
│  System webview  (WebView2 on Windows, WKWebView on macOS/iOS,        │
│                   WebKitGTK on Linux, Android System WebView)         │
│    React 19 UI  ──invoke("trim_clip", {...})──┐                       │
│                                               ▼                       │
│  Rust core (your code + the tauri crate)                              │
│    #[tauri::command] fn trim_clip(...) -> Result<Clip, String>        │
│    files, processes, OS APIs, plugins, permissions                    │
└───────────────────────────────────────────────────────────────────────┘
```

- **Small apps.** Tauri uses the webview the OS already has instead of bundling a whole browser, so
  a minimal app can be well under 1 MB (the Tauri docs quote "less than 600KB").
- **Native speed where it matters.** Hashing a 2 GB video, scanning a folder of clips or talking to
  hardware runs as compiled Rust, not JavaScript.
- **Safety at the boundary.** The code that touches the file system and the OS is the code an
  attacker would target, and in Rust it is memory-safe by default.

:::info title="Rust in the wild"
Rust runs in parts of the Windows kernel and Android, in Firefox, in Cloudflare's and AWS's
infrastructure, and in JavaScript tooling you already use: SWC, Turbopack, Biome, Rolldown (the
bundler behind Vite 8) and Lightning CSS. Learning it is not only about desktop apps.
:::

:::quiz id=rs-01-q1 xp=10
How does Rust free memory?
- [ ] A garbage collector runs on a background thread, like in C# and JavaScript
- [ ] The programmer calls `free()` by hand, like in C
- [x] Each value has one owner, and the compiler inserts the clean-up where the owner goes out of scope; unsafe patterns are rejected at compile time
- [ ] Reference counting on every value, like Swift
> Rust has no garbage collector and no manual `free`. The ownership rules let the compiler decide
> exactly where each value is dropped, and the borrow checker refuses code that could use a value
> after that point. Reference counting exists (`Rc`, `Arc`), but only when you ask for it.
:::

## The toolchain: rustup and cargo

Three tools, each with a JavaScript/.NET twin:

| Rust | Does | TS / Node twin | C# / .NET twin |
|---|---|---|---|
| `rustup` | installs and updates Rust toolchains | `nvm` / `fnm` | the .NET SDK installer |
| `cargo` | build, run, test, add dependencies | `npm` + `tsc` + `vitest` | `dotnet` CLI |
| `Cargo.toml` | project manifest | `package.json` | `.csproj` |
| `Cargo.lock` | exact versions | `package-lock.json` | `packages.lock.json` |
| crates.io | package registry | npmjs.com | nuget.org |
| docs.rs | API docs for every crate | (none built in) | learn.microsoft.com |

The commands you will use every day:

```bash
cargo new clip-trim      # new binary project (folder, Cargo.toml, src/main.rs, git repo)
cargo run                # build (debug) and run
cargo run -- 00:12 01:05 # everything after -- is passed to YOUR program
cargo build --release    # optimised build in target/release/
cargo test               # compile and run every #[test]
cargo check              # type-check only, much faster than build
cargo add serde          # add a dependency to Cargo.toml (like npm install)
cargo fmt / cargo clippy # formatter / linter (the "eslint" of Rust)
```

A fresh project's manifest:

```toml
[package]
name = "clip-trim"
version = "0.1.0"
edition = "2024"

[dependencies]
```

The **edition** is a language version you opt into per crate, like `"target"` in `tsconfig.json` or
`<LangVersion>` in a `.csproj`. Crates on different editions still link together. Edition 2024 is
the current one, and `cargo new` uses it by default.

:::tip title="cargo check is your watch mode"
`cargo check` skips code generation, so it is many times faster than `cargo build`. Editors with
**rust-analyzer** (the Rust language server for VS Code, Zed, JetBrains RustRover…) run it for you on
save. Most of your time in Rust is spent reading compiler messages, so get that loop fast.
:::

:::quiz id=rs-01-q2 xp=10
You run `cargo build --release`. Where is the executable, and how does it differ from `cargo run`'s?
- [ ] `dist/clip-trim`; it is the same binary, just copied
- [x] `target/release/clip-trim`; it is optimised and has integer overflow checks off, while `cargo run` builds the unoptimised debug profile into `target/debug/`
- [ ] `bin/Release/clip-trim`; release builds include the test code
- [ ] There is no executable; Rust is interpreted by cargo
> Cargo has two built-in profiles. `dev` (used by `cargo build`, `cargo run`, `cargo test`) is fast
> to compile, has debug info and panics on integer overflow. `release` is optimised and, by default,
> lets integers wrap. Both write to `target/<profile>/`. Rust compiles to native machine code: there
> is no VM or interpreter.
:::

## Variables: `let`, `mut` and shadowing

In Rust a variable is **immutable unless you say `mut`**, the opposite default from C# and closer
to TypeScript's `const`:

```rust
let title = "Intro";          // immutable, type inferred (&str)
let mut clips = 0;            // mutable
clips += 1;
let fps: f64 = 29.97;         // explicit type annotation, like TS
```

```ts
const title = 'Intro'
let clips = 0
clips += 1
const fps: number = 29.97
```

```csharp
var title = "Intro";          // C#: everything is mutable unless readonly/const
var clips = 0;
clips += 1;
double fps = 29.97;
```

**Shadowing** is new: you may declare a *new* variable with the *same name*, often with a different
type. The old one is hidden from then on.

```rust
let duration = "53";                    // &str from the command line
let duration: u32 = duration.parse().unwrap(); // new variable, now a number
println!("{}", duration + 1);           // 54
```

That is not mutation. It is two variables, and it is the idiomatic way to say "this is the same
thing, converted". It saves you from names like `durationStr` and `durationNum`.

:::quiz id=rs-01-q3 xp=10
Will this compile?

```rust
fn main() {
    let count = 1;
    count = 2;
    println!("{count}");
}
```

- [ ] Yes, it prints `2`
- [x] No: `error[E0384]: cannot assign twice to immutable variable count`; the fix is `let mut count = 1;`
- [ ] No: `error[E0308]: mismatched types`
- [ ] Yes, but it prints `1` because the assignment is ignored
> Bindings are immutable by default. rustc reports E0384 and even suggests the fix:
> `help: consider making this binding mutable: let mut count`. `rustc --explain E0384` prints a
> longer explanation of any error code.
:::

:::quiz id=rs-01-q4 xp=10
Will this compile, and what does it print?

```rust
fn main() {
    let input = "42";
    let input: u32 = input.parse().unwrap();
    println!("{}", input + 1);
}
```

- [x] Yes, it prints `43`: the second `let` **shadows** the first with a new `u32` variable
- [ ] No: E0384, `input` is assigned twice
- [ ] No: E0308, `input` can't change type from `&str` to `u32`
- [ ] Yes, it prints `421`
> Shadowing creates a new binding; nothing is reassigned, so the immutability rule is not broken and
> the new binding can have a different type. `parse()` returns a `Result`; `.unwrap()` takes the
> value out (and would crash on bad input, see Option and Result below).
:::

## Scalar types

Rust makes you choose the size of a number. That feels fussy coming from TS's single `number`,
but it is the same as C#'s `int`/`long`/`byte`, with clearer names:

| Rust | Meaning | C# | TS |
|---|---|---|---|
| `i8` `i16` `i32` `i64` `i128` | signed integers | `sbyte` `short` `int` `long` `Int128` | `number` / `bigint` |
| `u8` `u16` `u32` `u64` `u128` | unsigned integers | `byte` `ushort` `uint` `ulong` `UInt128` | `number` / `bigint` |
| `usize` / `isize` | pointer-sized; used for lengths and indexes | `nuint` / `nint` | `number` |
| `f32` `f64` | floats | `float` `double` | `number` |
| `bool` | `true` / `false` | `bool` | `boolean` |
| `char` | one Unicode scalar value (4 bytes) | `char` (2 bytes, UTF-16) | (none) |

Integer literals default to `i32`, floats to `f64`. There are **no implicit conversions**:
`let total: u64 = frames_u32;` is an error, and you write `u64::from(frames_u32)` or `frames as u64`.

**Overflow** is defined behaviour. In a debug build `255u8 + 1` **panics** (`attempt to add with
overflow`); in a release build it wraps to `0`. If you want a specific behaviour, say so:
`x.checked_add(1)` returns an `Option`, `x.wrapping_add(1)` wraps, `x.saturating_add(1)` stops at
the maximum.

:::quiz id=rs-01-q5 xp=10
`x` is a `u8` read from a file, and its value is `255`. What does `let y = x + 1;` do in a program
started with `cargo run`?
- [ ] `y` becomes `256`, because Rust widens the type automatically
- [ ] `y` silently becomes `0`
- [x] The program panics with `attempt to add with overflow` (debug builds check overflow); a `--release` build would wrap to `0` unless you enable overflow checks
- [ ] It's a compile error whenever a `u8` is added to
> Debug builds check integer arithmetic and panic on overflow. Release builds wrap by default
> (two's complement), which is why code that cares uses `checked_add` / `saturating_add`. If the
> compiler can see the overflow at compile time (`let x: u8 = 255; x + 1`), it refuses to build
> with the `arithmetic_overflow` lint.
:::

## Strings at a glance: `String` vs `&str`

This trips up everyone, so here is the short version now and the full story in the ownership lesson.

| | `String` | `&str` ("string slice") |
|---|---|---|
| What it is | an **owned**, growable buffer of UTF-8 on the heap | a **borrowed view** into some UTF-8 that someone else owns |
| Like in C# | `StringBuilder` that you own | `ReadOnlySpan<char>` |
| Literal | `String::from("Intro")`, `"Intro".to_string()` | `"Intro"` (lives in the binary) |
| Use it for | struct fields, return values you build | function **parameters** that only read |

```rust
fn shout(name: &str) -> String {      // borrow in, owned out
    format!("{}!", name.to_uppercase())
}

let owned = String::from("clip");
println!("{}", shout(&owned));        // &String converts to &str automatically
println!("{}", shout("literal"));     // a literal is already &str
```

The rule of thumb: **take `&str`, return `String`**. A function taking `&str` accepts both literals
and `String`s; a function taking `String` forces every caller to allocate.

:::quiz id=rs-01-q6 xp=10
Will this compile?

```rust
fn greet(name: String) {
    println!("Hello, {name}");
}

fn main() {
    greet("Ada");
}
```

- [ ] Yes; string literals convert to `String` automatically
- [x] No: `error[E0308]: mismatched types … expected String, found &str`; pass `"Ada".to_string()` or, better, change the parameter to `&str`
- [ ] No: `error[E0384]`, `name` is immutable
- [ ] Yes, but it prints `Hello, &str`
> A literal is a `&str`. Rust never allocates behind your back, so it won't turn it into a `String`
> silently. rustc even suggests `"Ada".to_string()`. For a function that only reads the name,
> `fn greet(name: &str)` is the idiomatic signature.
:::

## Tuples, arrays and `Vec`

```rust
let range: (u32, u32) = (12, 65);           // tuple: fixed size, mixed types
let (start, end) = range;                   // destructuring, like TS/C# deconstruction
println!("{} s", range.1 - range.0);        // fields by index

let rgb: [u8; 3] = [255, 128, 0];           // array: fixed length, part of the type
let mut clips: Vec<String> = Vec::new();    // Vec: growable, like T[] in TS / List<T> in C#
clips.push("intro.mp4".to_string());
let ids = vec![1, 2, 3];                    // vec! macro, like an array literal
println!("{} clips, first id {}", clips.len(), ids[0]);
println!("{:?}", ids);                      // {:?} = debug print: [1, 2, 3]
```

- `[u8; 3]` and `[u8; 4]` are **different types**. Use arrays for small fixed data, `Vec` for lists.
- `ids[10]` on a 3-element `Vec` **panics** (`index out of bounds: the len is 3 but the index is 10`).
  `ids.get(10)` returns `None` instead. Rust never returns `undefined`.
- Names ending in `!` (`println!`, `vec!`, `format!`) are **macros**: code that expands at compile
  time. `println!` checks the format string against its arguments while compiling.

## Functions and expressions

```rust
fn duration(start: u32, end: u32) -> u32 {
    end - start            // no semicolon: this is the return value
}
```

Parameters always have types (no inference across function boundaries), and `-> T` is the return
type. The big idea: **almost everything in Rust is an expression** that produces a value. A block
`{ … }` evaluates to its last expression **if that expression has no semicolon**. A semicolon turns
an expression into a statement whose value is `()`, the "unit" type (Rust's `void`).

```rust
let label = if seconds >= 60 { "long" } else { "short" };   // if is an expression (no ?: needed)

let kind = match ext {                                      // so is match
    "mp4" | "mov" => "video",
    "wav" => "audio",
    _ => "other",
};
```

```ts
const label = seconds >= 60 ? 'long' : 'short'
```

`return x;` still exists for early exits, but the last line of a function is usually a bare
expression.

:::quiz id=rs-01-q7 xp=10
Will this compile?

```rust
fn total(a: u32, b: u32) -> u32 {
    a + b;
}
```

- [ ] Yes; the last computed value is returned
- [x] No: `error[E0308]: mismatched types … expected u32, found ()`, because the semicolon makes the body return `()`; remove it
- [ ] No: `error[E0004]`
- [ ] Yes, but it returns `0`
> `a + b;` is a statement, so the block has no tail expression and evaluates to `()`. rustc says
> "implicitly returns `()` as its body has no tail or `return` expression" and points at the
> semicolon: `help: remove this semicolon to return this value`.
:::

## Structs and `impl`

A **struct** is data. Behaviour goes in a separate **`impl` block**. There are no classes and no
inheritance; shared behaviour comes from **traits** (lesson **Traits, generics, errors and crates**).

```rust
#[derive(Debug, Clone, PartialEq)]   // auto-generate debug printing, .clone(), ==
struct Clip {
    name: String,
    start: u32,
    end: u32,
}

impl Clip {
    // associated function (no self): a constructor by convention, called Clip::new(...)
    fn new(name: &str, start: u32, end: u32) -> Self {
        Self { name: name.to_string(), start, end }
    }

    // method: borrows the clip read-only
    fn duration(&self) -> u32 {
        self.end - self.start
    }

    // method: borrows it mutably, so the caller's variable must be `let mut`
    fn shift(&mut self, by: u32) {
        self.start += by;
        self.end += by;
    }
}

let mut intro = Clip::new("intro", 0, 12);
intro.shift(5);
println!("{:?} lasts {} s", intro, intro.duration());
// Clip { name: "intro", start: 5, end: 17 } lasts 12 s
```

The same in TS and C#:

```ts
class Clip {
  constructor(public name: string, public start: number, public end: number) {}
  duration() { return this.end - this.start }
  shift(by: number) { this.start += by; this.end += by }
}
```

```csharp
public record class Clip(string Name, int Start, int End)
{
    public int Duration => End - Start;
}
```

`&self` / `&mut self` say, in the signature, whether a method can change the object. In C# any
method can mutate `this`; in Rust you can see it from the outside.

## Enums with data, `match` and `if let`

Rust enums are **tagged unions**, like TS discriminated unions, not like C#'s named integers. Each
variant can carry different data:

```rust
enum Job {
    Queued,
    Running { percent: u8 },
    Failed(String),
    Done { output: String, seconds: u32 },
}
```

```ts
type Job =
  | { kind: 'queued' }
  | { kind: 'running'; percent: number }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; output: string; seconds: number }
```

You take an enum apart with **`match`**, and the compiler checks that **every variant is handled**:

```rust
fn status(job: &Job) -> String {
    match job {
        Job::Queued => "waiting".to_string(),
        Job::Running { percent } if *percent >= 99 => "finishing".to_string(),  // guard
        Job::Running { percent } => format!("{percent}%"),
        Job::Failed(msg) => format!("failed: {msg}"),
        Job::Done { output, .. } => format!("saved {output}"),                   // .. ignores the rest
    }
}
```

When you care about **one** variant only, `if let` is shorter, and `let … else` handles "get it
or leave":

```rust
if let Job::Failed(msg) = &job {
    eprintln!("ClipDesk job failed: {msg}");
}

let Job::Done { output, .. } = job else {
    return;            // the else branch must leave (return, break, continue or panic)
};
println!("open {output}");
```

C# has pattern matching too (`switch` expressions) and warns (CS8509) when a switch expression
misses a case, but its enums are open integers and its class hierarchies are open, so it can't prove
that you handled every case of a closed set. Rust can, so adding a variant turns every unfinished `match` into a compile error.
That is a refactoring tool, not a nuisance.

:::quiz id=rs-01-q8 xp=10
Will this compile?

```rust
enum Status { Queued, Running(u8), Done }

fn label(s: Status) -> &'static str {
    match s {
        Status::Queued => "queued",
        Status::Running(_) => "running",
    }
}
```

- [ ] Yes; an unmatched value returns an empty string
- [ ] Yes; it panics at runtime when called with `Done`
- [x] No: `error[E0004]: non-exhaustive patterns: Status::Done not covered`
- [ ] No: `error[E0308]`, `&'static str` is the wrong return type
> `match` must be exhaustive. rustc lists the missing pattern and suggests an arm. A wildcard
> `_ => …` would also compile, but it hides future variants, so prefer listing them when the enum is
> yours. (`&'static str` is a string slice that lives for the whole program, like a literal.)
:::

## `Option` and `Result` instead of null and exceptions

Rust has **no `null`** and **no exceptions**. Two ordinary enums from the standard library replace
them:

```rust
enum Option<T> { Some(T), None }        // a value, or nothing
enum Result<T, E> { Ok(T), Err(E) }     // a value, or an error
```

| Situation | TS | C# | Rust |
|---|---|---|---|
| maybe missing | `T \| undefined`, `?.`, `??` | `T?`, `?.`, `??` | `Option<T>`: `.map`, `.unwrap_or` |
| can fail | `throw` / `try…catch` | `throw` / `try…catch` | `Result<T, E>` returned; `?` passes it up |
| "this can't happen" | `throw new Error` | `throw new InvalidOperationException` | `panic!`, `.unwrap()`, `.expect("why")` |

Because they are types, the compiler won't let you use an `Option<&str>` as a `&str`. You must
decide what happens in the `None` case:

```rust
let first = clips.first();                    // Option<&String>
let name = first.map(|c| c.as_str()).unwrap_or("(empty)");   // |c| ... is a closure (arrow fn)

let fps: Result<f64, _> = "29.97".parse::<f64>();
match fps {
    Ok(v) => println!("{v} fps"),
    Err(e) => eprintln!("bad fps: {e}"),
}
```

The everyday helpers:

| Method | On `Some(x)` / `Ok(x)` | On `None` / `Err(e)` |
|---|---|---|
| `.map(f)` | `Some(f(x))` / `Ok(f(x))` | unchanged |
| `.and_then(f)` (f returns an Option/Result) | `f(x)` | unchanged |
| `.unwrap_or(d)` | `x` | `d` |
| `.ok_or(e)` (Option → Result) | `Ok(x)` | `Err(e)` |
| `.map_err(f)` (Result only) | unchanged | `Err(f(e))` |
| `.unwrap()` / `.expect("msg")` | `x` | **panic** |

### The `?` operator

Writing a `match` after every call gets noisy. **`?`** means: "if this is `Err(e)`, return
`Err(e)` from the current function right now (converting the error type with `From` if needed);
otherwise give me the `Ok` value". On an `Option`, it returns `None` early.

```rust
fn parse_range(start: &str, end: &str) -> Result<(u32, u32), std::num::ParseIntError> {
    let s: u32 = start.parse()?;     // early return on error
    let e: u32 = end.parse()?;
    Ok((s, e))
}
```

What `?` expands to, roughly:

```rust
let s: u32 = match start.parse() {
    Ok(v) => v,
    Err(e) => return Err(From::from(e)),
};
```

It reads like code with exceptions, but every place that can fail is marked with `?`, and the
function signature says that it can fail. A caller can't forget to handle it, and nothing
"unwinds" invisibly through ten frames.

:::quiz id=rs-01-q9 xp=10
Will this compile?

```rust
fn main() {
    let n: u32 = "42".parse()?;
    println!("{n}");
}
```

- [ ] Yes; `?` turns into a panic in `main`
- [x] No: `error[E0277]: the ? operator can only be used in a function that returns Result or Option`; make `main` return `Result<(), Box<dyn std::error::Error>>` and end with `Ok(())`
- [ ] No: `error[E0308]`, `parse` returns a string
- [ ] Yes; `n` becomes `0` if parsing fails
> `?` returns early with the error, so the function must have a `Result` (or `Option`) return type
> to return it in. `main` may return `Result<(), E>`: an `Err` is printed and the process exits with
> code 1. rustc suggests exactly that signature.
:::

:::quiz id=rs-01-q10 xp=10
`let name: Option<&str> = clips_dir_name();` and then `name.to_uppercase()`. What does rustc say?
- [ ] Nothing; it works like `name?.toUpperCase()` in TS and returns `None` for `None`
- [ ] It compiles and panics at runtime when `name` is `None`
- [x] `error[E0599]: no method named to_uppercase found for enum Option`; first decide what `None` means, e.g. `name.map(|n| n.to_uppercase())` or `name.unwrap_or("untitled").to_uppercase()`
- [ ] `error[E0384]`, `name` is immutable
> An `Option<&str>` is not a `&str`, so the string methods aren't there. This is the compile-time
> version of "Cannot read properties of undefined". `map` keeps the `Option`; `unwrap_or` picks a
> default; `expect("…")` crashes with a message if you are sure it can't be `None`.
:::

:::challenge id=rs-01-c1 lang=ts xp=40
title: Option helpers over a tagged union
Model Rust's `Option<T>` in TypeScript. The setup code gives you the type and the constructors
`some(value)` and `none`, plus a `Result` type with `ok` and `err`. Implement four helpers that
behave like their Rust namesakes:

- `map(opt, f)`: `some(f(x))` for `some(x)`, `none` stays `none` (and `f` is **not** called).
- `andThen(opt, f)`: `f` returns an `Option` itself; return it for `some(x)`, `none` stays `none`.
  (Like `.and_then`, it avoids `Option<Option<T>>`.)
- `unwrapOr(opt, fallback)`: the value, or `fallback`.
- `okOr(opt, error)`: `ok(x)` for `some(x)`, `err(error)` for `none`.

```rust
Some(3).map(|x| x * 2)                  // Some(6)
Some("12").and_then(|s| s.parse().ok()) // Some(12)
None.unwrap_or(0)                       // 0
None::<u32>.ok_or("missing")            // Err("missing")
```

hint: Check `opt.kind === 'some'` first; TypeScript then knows `opt.value` exists.
hint: For `none`, return the `none` constant (or `opt` itself). Don't call `f`.

```ts setup
type Option<T> = { kind: 'some'; value: T } | { kind: 'none' }
type Result<T, E> = { kind: 'ok'; value: T } | { kind: 'err'; error: E }
function some<T>(value: T): Option<T> { return { kind: 'some', value } }
const none: Option<never> = { kind: 'none' }
function ok<T>(value: T): Result<T, never> { return { kind: 'ok', value } }
function err<E>(error: E): Result<never, E> { return { kind: 'err', error } }
```

```ts starter
export function map<T, U>(opt: Option<T>, f: (x: T) => U): Option<U> {
  return none
}

export function andThen<T, U>(opt: Option<T>, f: (x: T) => Option<U>): Option<U> {
  return none
}

export function unwrapOr<T>(opt: Option<T>, fallback: T): T {
  return fallback
}

export function okOr<T, E>(opt: Option<T>, error: E): Result<T, E> {
  return err(error)
}
```

```ts solution
export function map<T, U>(opt: Option<T>, f: (x: T) => U): Option<U> {
  return opt.kind === 'some' ? some(f(opt.value)) : none
}

export function andThen<T, U>(opt: Option<T>, f: (x: T) => Option<U>): Option<U> {
  return opt.kind === 'some' ? f(opt.value) : none
}

export function unwrapOr<T>(opt: Option<T>, fallback: T): T {
  return opt.kind === 'some' ? opt.value : fallback
}

export function okOr<T, E>(opt: Option<T>, error: E): Result<T, E> {
  return opt.kind === 'some' ? ok(opt.value) : err(error)
}
```

```ts tests
const parseNum = (s: string): Option<number> => (/^\d+$/.test(s) ? some(Number(s)) : none)

test('map transforms some', () => {
  expect(map(some(3), (x: number) => x * 2)).toEqual({ kind: 'some', value: 6 })
})
test('map keeps none and does not call f', () => {
  const f = fn((x: number) => x * 2)
  expect(map(none, f)).toEqual({ kind: 'none' })
  expect(f).not.toHaveBeenCalled()
})
test('andThen flattens instead of nesting', () => {
  expect(andThen(some('12'), parseNum)).toEqual({ kind: 'some', value: 12 })
  expect(andThen(some('twelve'), parseNum)).toEqual({ kind: 'none' })
  expect(andThen(none, parseNum)).toEqual({ kind: 'none' })
})
test('unwrapOr returns the value or the fallback, even a falsy value', () => {
  expect(unwrapOr(some(0), 30)).toBe(0)
  expect(unwrapOr(none, 30)).toBe(30)
})
test('okOr turns an Option into a Result', () => {
  expect(okOr(some('intro.mp4'), 'missing')).toEqual({ kind: 'ok', value: 'intro.mp4' })
  expect(okOr(none, 'missing')).toEqual({ kind: 'err', error: 'missing' })
})
test('helpers chain like Rust method calls', () => {
  const fps = unwrapOr(map(andThen(some('30'), parseNum), (n: number) => n / 1.001), 25)
  expect(fps).toBeCloseTo(29.97, 2)
})
```
:::

:::challenge id=rs-01-c2 lang=ts xp=50
title: Result and the ? operator
Port the heart of this lesson's lab to TypeScript, writing the `?` operator out by hand. The setup
gives you `Result`, `ok`, `err` and the error type:

```ts
type TrimError =
  | { kind: 'usage' }
  | { kind: 'badTimestamp'; text: string }
  | { kind: 'endNotAfterStart'; start: number; end: number }
```

1. `parseTimestamp(text)`: `"mm:ss"` (digits, a colon, digits) → `ok(minutes * 60 + seconds)`.
   Anything else, or seconds ≥ 60, → `err({ kind: 'badTimestamp', text })`.
2. `parseTrim(args)`: exactly two arguments, else `err({ kind: 'usage' })`. Parse the start, then
   the end; **the first error is returned as it is** (that's what `?` does). If `end <= start`,
   return `endNotAfterStart`. Otherwise `ok({ start, end })`.

The Rust you are modelling:

```rust
fn parse_args(args: &[String]) -> Result<Trim, TrimError> {
    match args {
        [start, end] => {
            let start = parse_timestamp(start)?;
            let end = parse_timestamp(end)?;
            if end <= start {
                return Err(TrimError::EndNotAfterStart { start, end });
            }
            Ok(Trim { start, end })
        }
        _ => Err(TrimError::Usage),
    }
}
```

hint: `/^(\d+):(\d+)$/.exec(text)` gives you both parts, or `null`.
hint: `?` in TS: `const s = parseTimestamp(args[0]); if (s.kind === 'err') return s` then use `s.value`.
hint: Parse the end only after the start succeeded, so a bad start is the error you report.

```ts setup
type Result<T, E> = { kind: 'ok'; value: T } | { kind: 'err'; error: E }
function ok<T>(value: T): Result<T, never> { return { kind: 'ok', value } }
function err<E>(error: E): Result<never, E> { return { kind: 'err', error } }
type TrimError =
  | { kind: 'usage' }
  | { kind: 'badTimestamp'; text: string }
  | { kind: 'endNotAfterStart'; start: number; end: number }
type Trim = { start: number; end: number }
```

```ts starter
export function parseTimestamp(text: string): Result<number, TrimError> {
  return err({ kind: 'badTimestamp', text })
}

export function parseTrim(args: string[]): Result<Trim, TrimError> {
  return err({ kind: 'usage' })
}
```

```ts solution
export function parseTimestamp(text: string): Result<number, TrimError> {
  const m = /^(\d+):(\d+)$/.exec(text)
  if (!m) return err({ kind: 'badTimestamp', text })
  const minutes = Number(m[1])
  const seconds = Number(m[2])
  if (seconds >= 60) return err({ kind: 'badTimestamp', text })
  return ok(minutes * 60 + seconds)
}

export function parseTrim(args: string[]): Result<Trim, TrimError> {
  if (args.length !== 2) return err({ kind: 'usage' })
  const start = parseTimestamp(args[0])
  if (start.kind === 'err') return start // ?
  const end = parseTimestamp(args[1])
  if (end.kind === 'err') return end // ?
  if (end.value <= start.value) return err({ kind: 'endNotAfterStart', start: start.value, end: end.value })
  return ok({ start: start.value, end: end.value })
}
```

```ts tests
test('parses mm:ss into seconds', () => {
  expect(parseTimestamp('01:05')).toEqual({ kind: 'ok', value: 65 })
  expect(parseTimestamp('0:07')).toEqual({ kind: 'ok', value: 7 })
})
test('rejects bad timestamps with the original text', () => {
  for (const text of ['105', '1:xx', '1:60', '-1:00', '']) {
    expect(parseTimestamp(text)).toEqual({ kind: 'err', error: { kind: 'badTimestamp', text } })
  }
})
test('a valid range', () => {
  expect(parseTrim(['00:12', '01:05'])).toEqual({ kind: 'ok', value: { start: 12, end: 65 } })
})
test('wrong argument count is a usage error', () => {
  expect(parseTrim([])).toEqual({ kind: 'err', error: { kind: 'usage' } })
  expect(parseTrim(['00:01', '00:02', '00:03'])).toEqual({ kind: 'err', error: { kind: 'usage' } })
})
test('end must be after start', () => {
  expect(parseTrim(['01:00', '00:30'])).toEqual({ kind: 'err', error: { kind: 'endNotAfterStart', start: 60, end: 30 } })
  expect(parseTrim(['00:30', '00:30']).kind).toBe('err')
})
test('the first error wins, like ?', () => {
  expect(parseTrim(['oops', 'nope'])).toEqual({ kind: 'err', error: { kind: 'badTimestamp', text: 'oops' } })
  expect(parseTrim(['00:10', 'nope'])).toEqual({ kind: 'err', error: { kind: 'badTimestamp', text: 'nope' } })
})
```
:::

## Side by side: the same function in three languages

Read a clip length from a config value that may be missing or malformed:

```ts
function clipSeconds(raw: string | undefined): number {
  if (raw === undefined) return 30
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error(`bad length: ${raw}`)
  return n
}
```

```csharp
static int ClipSeconds(string? raw)
{
    if (raw is null) return 30;
    if (!int.TryParse(raw, out var n)) throw new FormatException($"bad length: {raw}");
    return n;
}
```

```rust
fn clip_seconds(raw: Option<&str>) -> Result<u32, String> {
    match raw {
        None => Ok(30),
        Some(text) => text.parse().map_err(|e| format!("bad length: {text} ({e})")),
    }
}
```

The Rust signature tells the caller three things the others hide: the input may be absent, the
call may fail, and the error is a `String`. Nothing can be thrown past the caller.

:::job title="What you'll meet in a real Rust codebase"
- `cargo fmt --check` and `cargo clippy -- -D warnings` in CI: formatting and lint warnings fail the
  build. Run them before you push.
- `.unwrap()` is fine in tests and quick prototypes, but reviewers will ask about every one in
  application code. Use `?`, or `.expect("why this can't fail")` when it really can't.
- Error types are an enum per module (like the lab's `TrimError`), usually written with the
  `thiserror` crate in libraries and `anyhow` in applications; see **Traits, generics, errors and
  crates**.
- In Tauri, a command that can fail returns `Result<T, E>` (both sides must implement
  `serde::Serialize`), and an `Err` becomes a rejected promise from `invoke` in your React code. The patterns from this lesson are exactly what crosses that bridge.
:::

:::pro title="How seniors write Rust"
They **make invalid states unrepresentable**: instead of a struct with `is_running: bool` and
`percent: Option<u8>` and `error: Option<String>` (eight combinations, most of them nonsense), they
write an enum like `Job` above, so the compiler rejects the impossible ones. They read the **whole**
compiler message, including the `help:` lines, which often contain the fix. And they reach for
`rustc --explain E0xxx` and docs.rs before Stack Overflow.
:::

:::lab id=rs-01-lab1 xp=100
title: clip-trim, a small CLI with Result-based errors
You will install Rust, create a project with cargo, write a command-line tool that turns two
timestamps into a ClipDesk trim range, handle every bad input with `Result` and `?`, and verify it
with `#[test]` tests. Works on Windows, macOS and Linux.

**1. Install Rust with rustup**

macOS / Linux:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# choose 1) default installation, then open a new terminal (or: . "$HOME/.cargo/env")
```

Windows: download and run `rustup-init.exe` from https://rustup.rs. It offers to install the
**Visual Studio C++ Build Tools** (the MSVC linker Rust needs); accept that.

:::info
Linux distributions also package Rust, but use rustup for this region: Tauri and the mobile targets
need `rustup target add …`, which distro packages don't support. If you already have rustup, run
`rustup update stable`.
:::

Check it:

```bash
rustc --version
cargo --version
```

Expected: `rustc 1.85.0` or newer (edition 2024 needs at least 1.85), and a matching `cargo`.

**2. Create the project**

```bash
mkdir -p ~/devquest-labs && cd ~/devquest-labs
cargo new clip-trim
cd clip-trim
cargo run
```

Expected:

```text
    Creating binary (application) `clip-trim` package
note: see more `Cargo.toml` keys and their definitions at https://doc.rust-lang.org/cargo/reference/manifest.html
   Compiling clip-trim v0.1.0 (…/devquest-labs/clip-trim)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.40s
     Running `target/debug/clip-trim`
Hello, world!
```

Open `Cargo.toml` and check that it says `edition = "2024"`.

**3. Replace `src/main.rs`**

```rust
use std::fmt;
use std::process::ExitCode;

/// Everything that can go wrong while reading the command line.
#[derive(Debug, PartialEq)]
enum TrimError {
    Usage,
    BadTimestamp(String),
    EndNotAfterStart { start: u32, end: u32 },
}

// Display = the human-readable message, like overriding ToString() in C#.
impl fmt::Display for TrimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TrimError::Usage => write!(f, "usage: clip-trim <start mm:ss> <end mm:ss>"),
            TrimError::BadTimestamp(text) => write!(f, "bad timestamp '{text}', expected mm:ss"),
            TrimError::EndNotAfterStart { start, end } => {
                write!(f, "end ({end} s) must be after start ({start} s)")
            }
        }
    }
}

/// A trim range in whole seconds.
#[derive(Debug, PartialEq)]
struct Trim {
    start: u32,
    end: u32,
}

impl Trim {
    fn duration(&self) -> u32 {
        self.end - self.start
    }
}

fn bad(text: &str) -> TrimError {
    TrimError::BadTimestamp(text.to_string())
}

/// "01:05" -> Ok(65). Anything else -> Err(BadTimestamp).
fn parse_timestamp(text: &str) -> Result<u32, TrimError> {
    let (mm, ss) = text.split_once(':').ok_or_else(|| bad(text))?;
    let minutes: u32 = mm.parse().map_err(|_| bad(text))?;
    let seconds: u32 = ss.parse().map_err(|_| bad(text))?;
    if seconds >= 60 {
        return Err(bad(text));
    }
    Ok(minutes * 60 + seconds)
}

fn parse_args(args: &[String]) -> Result<Trim, TrimError> {
    match args {
        [start, end] => {
            let start = parse_timestamp(start)?;
            let end = parse_timestamp(end)?;
            if end <= start {
                return Err(TrimError::EndNotAfterStart { start, end });
            }
            Ok(Trim { start, end })
        }
        _ => Err(TrimError::Usage),
    }
}

fn format_timestamp(total: u32) -> String {
    format!("{:02}:{:02}", total / 60, total % 60)
}

fn main() -> ExitCode {
    // skip(1): the first argument is the program's own path
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Ok(trim) => {
            println!(
                "trim {} -> {} ({} s)",
                format_timestamp(trim.start),
                format_timestamp(trim.end),
                trim.duration()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}
```

Read it once from top to bottom and find: an enum with data, an `impl` for a trait (`Display`), a
struct with a method, `?` used five times, `ok_or_else` turning an `Option` into a `Result`,
`map_err` converting the standard library's `ParseIntError` into your error, and a `match` on a
slice pattern (`[start, end]` matches exactly two elements).

**4. Run it**

```bash
cargo run -- 00:12 01:05
cargo run -q -- 01:00 00:30; echo "exit code $?"
cargo run -q -- 1:xx 2:00
cargo run -q
```

(On Windows PowerShell use `echo "exit code $LASTEXITCODE"`.) Expected:

```text
trim 00:12 -> 01:05 (53 s)
error: end (30 s) must be after start (60 s)
exit code 2
error: bad timestamp '1:xx', expected mm:ss
error: usage: clip-trim <start mm:ss> <end mm:ss>
```

`-q` hides cargo's own `Compiling…` lines. Errors go to **stderr** (`eprintln!`) and the exit code is
`2`, so scripts can tell success from failure.

**5. Add the tests**

Append this to the end of `src/main.rs`. `#[cfg(test)]` means the module is only compiled for
`cargo test`, and `use super::*;` imports everything from the file above, private items included.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_minutes_and_seconds() {
        assert_eq!(parse_timestamp("01:05"), Ok(65));
        assert_eq!(parse_timestamp("0:07"), Ok(7));
    }

    #[test]
    fn rejects_bad_timestamps() {
        for text in ["105", "1:xx", "1:60", "-1:00", ""] {
            assert_eq!(parse_timestamp(text), Err(TrimError::BadTimestamp(text.to_string())));
        }
    }

    #[test]
    fn parses_a_valid_range() {
        let trim = parse_args(&args(&["00:12", "01:05"])).unwrap();
        assert_eq!(trim, Trim { start: 12, end: 65 });
        assert_eq!(trim.duration(), 53);
    }

    #[test]
    fn wrong_argument_count_is_a_usage_error() {
        assert_eq!(parse_args(&args(&[])), Err(TrimError::Usage));
        assert_eq!(parse_args(&args(&["00:01", "00:02", "00:03"])), Err(TrimError::Usage));
    }

    #[test]
    fn end_must_be_after_start() {
        assert_eq!(
            parse_args(&args(&["01:00", "00:30"])),
            Err(TrimError::EndNotAfterStart { start: 60, end: 30 })
        );
    }

    #[test]
    fn the_first_bad_argument_wins() {
        assert_eq!(
            parse_args(&args(&["oops", "nope"])),
            Err(TrimError::BadTimestamp("oops".to_string()))
        );
    }

    #[test]
    fn formats_with_two_digits() {
        assert_eq!(format_timestamp(65), "01:05");
        assert_eq!(format_timestamp(7), "00:07");
    }

    #[test]
    fn error_messages_are_readable() {
        assert_eq!(bad("1:xx").to_string(), "bad timestamp '1:xx', expected mm:ss");
    }
}
```

`assert_eq!` compares with `==` (that's why the types derive `PartialEq`) and prints both values
with `{:?}` on failure (that's why they derive `Debug`).

**6. Run the tests**

```bash
cargo test
```

Expected (test order and timings may vary):

```text
   Compiling clip-trim v0.1.0 (…/devquest-labs/clip-trim)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.45s
     Running unittests src/main.rs (target/debug/deps/clip_trim-…)

running 8 tests
test tests::end_must_be_after_start ... ok
test tests::error_messages_are_readable ... ok
test tests::formats_with_two_digits ... ok
test tests::parses_a_valid_range ... ok
test tests::parses_minutes_and_seconds ... ok
test tests::rejects_bad_timestamps ... ok
test tests::the_first_bad_argument_wins ... ok
test tests::wrong_argument_count_is_a_usage_error ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

**7. Break it on purpose** (undo each change before the next, and run `cargo build` each time):

| Change in `src/main.rs` | Expected error |
|---|---|
| `Ok(minutes * 60 + seconds)` → add a `;` at the end | `error[E0308]: mismatched types … expected Result<u32, TrimError>, found ()` |
| In `parse_args`, delete the `_ => Err(TrimError::Usage),` arm | `error[E0004]: non-exhaustive patterns: &[], &[_] and &[_, _, _, ..] not covered` |
| In `TrimError::fmt`, delete the `TrimError::Usage => …` arm | `error[E0004]: non-exhaustive patterns: &TrimError::Usage not covered` |
| In `main`, add `let _trim = parse_args(&args)?;` right after the `let args` line | `error[E0277]: the ? operator can only be used in a function that returns Result or Option` |
| In `parse_timestamp`, replace the whole `let minutes: u32 = …;` line with `let minutes: u32 = mm;` | `error[E0308]: mismatched types … expected u32, found &str` |

Then put things back and run `cargo test` once more: 8 passed.

:::tip title="Your turn"
Support `hh:mm:ss` as well (`"1:02:03"` → `3723`). Write the test first, watch it fail with
`cargo test`, then change `parse_timestamp`. Hint: `text.split(':').collect::<Vec<_>>()` and a
`match` on the slice, `[mm, ss]` and `[hh, mm, ss]`.
:::

- [ ] `rustc --version` prints 1.85 or newer and `Cargo.toml` says `edition = "2024"`
- [ ] `cargo run -- 00:12 01:05` prints `trim 00:12 -> 01:05 (53 s)`
- [ ] Bad input prints an `error: …` line on stderr and exits with code 2
- [ ] `cargo test` reports `8 passed; 0 failed`
- [ ] I triggered E0308, E0004 and E0277 and can say what each one means
:::

## How it breaks in practice

The mistakes TS and C# developers make most in their first weeks of Rust, and what to do instead.

| Symptom | Cause | Fix |
|---|---|---|
| `E0384: cannot assign twice to immutable variable` | coming from C#, where everything is mutable | `let mut`, or better, shadow with a new `let` if it's a conversion |
| `E0308: expected u32, found ()` on a function | a `;` after the last expression | remove the semicolon (or write `return x;`) |
| `E0308: expected String, found &str` | passing a literal to a `String` parameter | take `&str` in the parameter; call `.to_string()` only when you must own it |
| `E0599: no method … found for enum Option` | treating `Option<T>` as `T` | `map`, `unwrap_or`, `if let Some(x)`, or `?` in a function returning `Option` |
| `E0277: the ? operator can only be used in a function that returns Result` | `?` in `main` or a `-> ()` function | return `Result<(), E>`; for `main`, `Box<dyn std::error::Error>` is fine |
| `E0004: non-exhaustive patterns` after adding an enum variant | a new variant not handled | handle it everywhere the compiler points; avoid `_ =>` on your own enums |
| App crashes with `called Result::unwrap() on an Err value` | `.unwrap()` on user input or files | propagate with `?` and show the error; keep `unwrap` for tests |
| `thread 'main' panicked … index out of bounds` | `v[i]` with a bad index | `v.get(i)` returns `Option`; or iterate instead of indexing |
| Works with `cargo run`, wrong numbers in `--release` | integer overflow wraps in release, panics in debug | `checked_*` / `saturating_*`, or a wider type (`u64`) |
| Compiles slowly, editor feels laggy | running `cargo build` for every change | `cargo check` / rust-analyzer while editing; build when you run |

:::cards id=rs-01-cards1 xp=15 title="Rust primer"
Q: How does Rust manage memory?
A: Ownership: each value has one owner and is dropped when the owner goes out of scope. No garbage collector, no manual free; the borrow checker rejects unsafe use at compile time.
Q: Why does Tauri use Rust for its core?
A: Native speed and memory safety for the code that touches files and the OS, no runtime to ship, and small apps because the UI runs in the system webview.
Q: rustup vs cargo vs Cargo.toml?
A: rustup installs toolchains (like nvm). cargo builds, runs, tests and adds dependencies (like npm/dotnet). Cargo.toml is the manifest (like package.json/.csproj).
Q: What is the edition?
A: A language version chosen per crate (`edition = "2024"`); crates of different editions link together.
Q: `let` vs `let mut` vs shadowing?
A: `let` is immutable, `let mut` can be reassigned, and a second `let` with the same name creates a new variable (it may have a different type).
Q: Integer overflow in debug vs release?
A: Debug panics ("attempt to add with overflow"); release wraps. Use `checked_add`, `wrapping_add` or `saturating_add` to be explicit.
Q: `String` vs `&str`?
A: `String` owns a growable UTF-8 buffer; `&str` borrows a view of one. Take `&str` in parameters, return `String`.
Q: When does a block return a value?
A: Its last expression has no semicolon. A semicolon makes it a statement of type `()`.
Q: `&self` vs `&mut self`?
A: `&self` methods only read; `&mut self` methods may change the value, and the caller needs a `let mut` binding.
Q: How are Rust enums different from C# enums?
A: They are tagged unions: each variant can carry its own data, like TS discriminated unions. `match` must handle every variant.
Q: `if let` and `let … else`?
A: `if let Pattern = value { … }` handles one variant; `let Pattern = value else { return };` binds it or leaves the function.
Q: What replaces null and exceptions?
A: `Option<T>` (`Some`/`None`) and `Result<T, E>` (`Ok`/`Err`), both ordinary enums the compiler makes you handle.
Q: What does `?` do?
A: On `Err(e)` it returns `Err(From::from(e))` from the current function (on `None`, returns `None`); otherwise it unwraps the value.
Q: `map` vs `and_then`?
A: `map(f)` wraps f's result; `and_then(f)` is for an f that itself returns an Option/Result, so you don't get `Option<Option<T>>`.
Q: E0384 / E0308 / E0004 / E0277?
A: Assign to immutable variable / mismatched types (often a stray `;`) / non-exhaustive match / trait not implemented (e.g. `?` in a function that doesn't return Result).
:::

## Recap

- Rust frees memory through **ownership** checked at compile time: no garbage collector, no manual
  `free`, no use-after-free. That is why desktop shells like **Tauri** put a Rust core under a
  system webview.
- `rustup` installs toolchains, `cargo` builds/runs/tests, `Cargo.toml` is the manifest, and
  `edition = "2024"` picks the language version. `cargo check` keeps the edit loop fast.
- Variables are immutable by default (`let mut` to change); **shadowing** re-declares a name, often
  to convert its type. Numbers have explicit sizes and no implicit conversions.
- **Take `&str`, return `String`.** Tuples and arrays are fixed size; `Vec` is the growable list,
  and `get` returns `Option` where indexing would panic.
- Blocks, `if` and `match` are **expressions**; a missing semicolon is the return value.
- **Structs** hold data, `impl` blocks add methods (`&self` reads, `&mut self` changes), and
  **enums** are tagged unions checked exhaustively by `match`, with `if let` and `let … else` for
  one case.
- **`Option`** and **`Result`** replace null and exceptions; `map`, `and_then`, `unwrap_or`,
  `ok_or`, `map_err` transform them, and **`?`** returns errors early while marking every place that
  can fail.
- Read rustc's whole message, including `help:`; the codes you met here are E0384, E0308, E0004,
  E0277 and E0599. Next: **Ownership, borrowing and lifetimes**.
