---
id: rs-03
title: Traits, generics, errors and crates
level: intermediate
minutes: 110
xp: 180
summary: The tools every real Rust codebase is built from — traits and generics, iterators and closures, modules and workspaces, typed errors with thiserror and anyhow, serde, tests, clippy and a supply-chain check.
---

In **Rust for TypeScript and C# developers** you wrote functions, structs, enums and `match`. In
**Ownership, borrowing and lifetimes** you learned why the compiler stops you sharing data
carelessly. That is enough for a single file. It is not enough for an app.

A real desktop app is many crates written by many people. Take **ClipDesk**, the small media-tool
desktop app this region builds. It has a domain library (`clip-core`) that parses and validates clips.
The Tauri app (from **Tauri 2: a desktop app with a web frontend**) uses that library, a command-line
tool uses it, and both have tests. To build it you need answers to some everyday questions:

- How do I say "anything that can be exported" without inheritance? → **traits**
- How do I write one function for many types without losing speed? → **generics with bounds**
- How do I transform a list without index loops? → **iterators and closures**
- How do I split code into files and crates, and what is public? → **modules, visibility, workspaces**
- How do I report errors that a caller can `match` on, and errors a human can read? → **thiserror, anyhow, `?`**
- How do I send a struct to the TypeScript frontend? → **serde**
- How do I know it works, and that my dependencies are safe? → **cargo test, clippy, rustfmt, cargo audit, cargo deny**

This lesson covers each of these, comparing it to TypeScript and C# where that helps. The lab
then builds a two-crate workspace you will reuse in later lessons.

:::info title="Words you'll meet in this lesson"
- **Crate**: one compilation unit, either a library (`lib.rs`) or a binary (`main.rs`). It is the
  closest thing to an npm package or a .NET assembly.
- **Package**: a `Cargo.toml` plus one or more crates. People often say "crate" for both.
- **Workspace**: several packages that share one `Cargo.lock` and one `target/` folder, like an npm
  workspace or a .NET solution.
- **Trait**: a named set of methods a type can implement, like an interface.
- **Monomorphization**: the compiler makes a separate copy of a generic function for each concrete
  type it is used with.
- **Derive macro**: `#[derive(...)]` writes trait implementations for you at compile time, much like a
  C# source generator.
- **Advisory**: a published security notice about a crate version (RustSec ids look like `RUSTSEC-2024-0001`).
:::

## Traits: interfaces without inheritance

Rust has no classes and no inheritance. Shared behaviour is described by **traits**. A trait lists
method signatures and can also give default bodies. Any type, whether a struct, an enum or even `u64`,
can implement it.

```rust
pub trait Exporter {
    /// Required: every exporter must say what file extension it writes.
    fn extension(&self) -> &'static str;

    /// Required: turn a clip into bytes.
    fn export(&self, clip: &Clip) -> Vec<u8>;

    /// Default method: implementors get it for free, and may override it.
    fn file_name(&self, clip: &Clip) -> String {
        format!("{}.{}", clip.title.to_lowercase().replace(' ', "-"), self.extension())
    }
}

pub struct Mp4Exporter { pub crf: u8 }
pub struct GifExporter;

impl Exporter for Mp4Exporter {
    fn extension(&self) -> &'static str { "mp4" }
    fn export(&self, clip: &Clip) -> Vec<u8> { /* call the encoder */ Vec::new() }
}

impl Exporter for GifExporter {
    fn extension(&self) -> &'static str { "gif" }
    fn export(&self, clip: &Clip) -> Vec<u8> { Vec::new() }
    fn file_name(&self, clip: &Clip) -> String {        // override the default
        format!("{}-preview.gif", clip.title.to_lowercase())
    }
}
```

How this compares with what you know:

| | TypeScript `interface` | C# `interface` | Rust `trait` |
|---|---|---|---|
| Matching | **Structural**: any object with the right shape fits | **Nominal**: the class must declare `: IExporter` | **Nominal**: there must be an `impl Exporter for T` block |
| Where the implementation lives | n/a | Inside the class | In a **separate `impl` block**, which can be in another file or crate |
| Default methods | No | Yes (default interface methods, C# 8+) | Yes |
| Implement for a type you didn't write | Declaration merging (hacky) | Extension methods (not real interface impls) | Yes, with the **orphan rule** (see below) |
| Fields | Yes | Properties | **No fields**, methods only |

The separate `impl` block is the big difference. You can add your own trait to `String` or
`Vec<T>`. That is how `anyhow` adds a `.context(...)` method to `Result` and `Option`.

**The orphan rule.** You may write `impl Trait for Type` only if **the trait or the type is defined
in your crate**. Without this rule, two crates could each implement `Display for Vec<u8>`
differently, and the compiler could not choose between them. You cannot implement the std trait
`Display` for the std type `Vec<Clip>`. You can wrap it in your own type: `struct Timeline(Vec<Clip>)`
(the *newtype* pattern) and implement `Display` for `Timeline`.

**Using a trait's methods requires the trait in scope.** `x.context("…")` only compiles after
`use anyhow::Context;`. If it is missing you get `error[E0599]: no method named 'context' found`,
and the compiler suggests the `use` line. Read the suggestion.

### Std traits you will implement or derive every day

| Trait | What it gives | TS / C# analogue |
|---|---|---|
| `Debug` | `{:?}` formatting for developers, needed by `assert_eq!` and `unwrap()` messages | `console.log` of an object / `ToString()` in the debugger |
| `Display` | `{}` formatting for users; also gives `.to_string()` | `toString()` / `ToString()` override |
| `Clone` | An explicit deep-ish copy: `.clone()` | `structuredClone` / `ICloneable` |
| `Copy` | Implicit bit copy for small values (`u64`, `bool`, small structs of `Copy` fields) | Value types (C# `struct`) |
| `PartialEq` / `Eq` | `==` and `!=` | `IEquatable<T>` |
| `PartialOrd` / `Ord` | `<`, `>`, sorting | `IComparable<T>` |
| `Hash` | Use as a `HashMap` key (together with `Eq`) | `GetHashCode()` |
| `Default` | `T::default()` with "empty" values | parameterless constructor |
| `From<T>` / `Into<T>` | Conversions; `?` uses `From` to convert errors | implicit/explicit conversion operators |
| `Serialize` / `Deserialize` (serde) | To and from JSON (and many other formats) | `System.Text.Json` attributes |

Most of these you don't write by hand, you **derive** them:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
```

A derive only works if **every field** implements that trait. `#[derive(Copy)]` on `Clip` fails
because `String` is not `Copy`, since copying it would mean copying a heap buffer. The standard
library has no derive for `Display`, because the compiler can't guess how *your users* want to see a
value. (Crates such as `thiserror` generate a `Display` impl, but only from a format string you write.)

:::quiz id=rs-03-q1 xp=10
Will this compile? If not, which errors appear?

```rust
struct Clip { title: String }

fn main() {
    let a = Clip { title: "Intro".into() };
    let b = Clip { title: "Intro".into() };
    assert_eq!(a, b);
}
```

- [ ] It compiles, and the assertion passes because the fields are equal.
- [ ] It compiles, but the assertion fails because `a` and `b` are different objects.
- [x] It fails: `E0369` (`==` cannot be applied to `Clip`) and `E0277` (`Clip` doesn't implement `Debug`).
- [ ] It fails with `E0382` (use of moved value) because `assert_eq!` moves `a`.
> `assert_eq!` needs `PartialEq` to compare and `Debug` to print both sides when they differ.
> Neither exists until you write `#[derive(Debug, PartialEq)]`. Rust never invents equality for you.
> C# would silently fall back to reference equality, and TS `===` compares references.
:::

## Generics with trait bounds

A generic function in Rust looks like one in TS or C#, but the compiler checks the body
**against what you promised about `T`**, and nothing else:

```rust
fn longest<T>(items: &[T]) -> &T {
    let mut best = &items[0];
    for x in items {
        if x > best { best = x; }   // error[E0369]: binary operation `>` cannot be applied to type `&T`
    }
    best
}
```

In TypeScript `T` could be anything, and `>` would happily compare objects as strings. Rust refuses:
nothing says a `T` can be compared. You add a **trait bound**:

```rust
fn longest<T: PartialOrd>(items: &[T]) -> &T { /* same body, now compiles */ }
```

When bounds get long, move them into a **`where` clause**. It means the same thing and is easier to read:

```rust
use std::fmt::Display;

fn summary<T, E>(items: &[T], exporter: &E) -> String
where
    T: Display + Clone,       // several bounds with +
    E: Exporter + ?Sized,     // ?Sized: also accept a `dyn Exporter` behind a reference
{
    items.iter().map(|i| format!("{i} -> {}", exporter.extension())).collect::<Vec<_>>().join("\n")
}
```

**How generics are compiled.** Rust **monomorphizes**: `longest::<u64>` and `longest::<String>` become
two separate machine-code functions, each as fast as a hand-written version. C# does the same for value
types. TypeScript erases generics completely. The cost is a bigger binary and longer compile times
when a generic is used with many types.

**Generics on types and impls** work the same way:

```rust
pub struct Track<T> { pub items: Vec<T> }

impl<T: Clone> Track<T> {          // these methods exist only when T: Clone
    pub fn duplicated(&self) -> Vec<T> { self.items.iter().cloned().chain(self.items.iter().cloned()).collect() }
}
```

:::quiz id=rs-03-q2 xp=10
You wrote `fn largest<T>(xs: &[T]) -> &T` and the body uses `x > best`. The compiler says
`error[E0369]: binary operation '>' cannot be applied to type '&T'`. What is the idiomatic fix?
- [ ] Cast both sides: `(x as i64) > (best as i64)`.
- [x] Add a bound: `fn largest<T: PartialOrd>(xs: &[T]) -> &T`.
- [ ] Replace `T` with `Box<dyn Any>` so any type is accepted.
- [ ] Add `#[allow(E0369)]` above the function.
> The body may only use what the bounds promise. `PartialOrd` is the trait behind `<` and `>`, so the
> bound is exactly the promise the body needs. Callers with non-comparable types now get an error
> *at the call site*, which is where the mistake is. Compiler errors can't be silenced with `#[allow]`;
> that only works for lints.
:::

## `impl Trait` vs `dyn Trait`

There are two ways to say "some type that implements `Exporter`". Picking the right one is a
question you'll hear in code review.

```rust
// 1. impl Trait in argument position: sugar for a generic. Static dispatch.
fn save(exporter: &impl Exporter, clip: &Clip) { /* … */ }
//    same as: fn save<E: Exporter>(exporter: &E, clip: &Clip)

// 2. impl Trait in return position: "one concrete type, but I won't name it"
fn default_exporter() -> impl Exporter { Mp4Exporter { crf: 23 } }

// 3. dyn Trait: a trait object. Dynamic dispatch through a vtable, any type at runtime.
fn all_exporters() -> Vec<Box<dyn Exporter>> {
    vec![Box::new(Mp4Exporter { crf: 23 }), Box::new(GifExporter)]
}
```

```text
impl Trait / generics (static)          dyn Trait (dynamic)
──────────────────────────────          ─────────────────────────────────────
save::<Mp4Exporter>  ─┐                 Box<dyn Exporter> = [ data ptr | vtable ptr ]
save::<GifExporter>  ─┤ one copy                                          │
                      │ per type                            ┌─────────────┴──────────┐
call is direct,       │                                     │ extension → Gif::ext   │
can be inlined        ┘                                     │ export    → Gif::export│
                                                            └────────────────────────┘
one type per call site                  mixed types in one Vec, one call through a pointer
```

| Use | When |
|---|---|
| `impl Trait` / generics | The default. You know the type at compile time, so you get the fastest code. |
| `Box<dyn Trait>` / `&dyn Trait` | You need **different types in one collection**, a plugin list, or the choice is made at runtime (a user picks "GIF" in a dropdown). |

Two compile errors teach the limits:

- **`-> impl Exporter` must be one type.** `if gif { GifExporter } else { Mp4Exporter { crf: 23 } }`
  fails with `error[E0308]: 'if' and 'else' have incompatible types`. Return `Box<dyn Exporter>` instead.
- **Not every trait can become `dyn`.** A trait with a generic method (`fn encode<T>(&self, x: T)`) or one
  that returns `Self` can't have a vtable, because there is no single function pointer to store. You get
  `error[E0038]: the trait 'Encoder' is not dyn compatible` (older compilers said "object safe").

C# developers: `dyn Exporter` behaves like an `IExporter` variable, which is always dynamic in .NET.
Rust makes you **choose**, and the default choice (generics) costs nothing at runtime.

:::quiz id=rs-03-q3 xp=10
ClipDesk's settings screen lets the user add any number of export targets (MP4, GIF, WebM) in any
order, and they are all run on "Export all". Which type fits the list?
- [ ] `Vec<impl Exporter>`
- [x] `Vec<Box<dyn Exporter>>`
- [ ] `Vec<Exporter>`
- [ ] `fn exporters<E: Exporter>() -> Vec<E>`
> The list mixes different concrete types chosen at runtime, so it needs trait objects. `impl Trait`
> and `E: Exporter` both mean *one* concrete type for the whole `Vec`. A bare `Vec<Exporter>` is not
> valid Rust 2021+: a trait isn't a type of known size. It needs `dyn` and a pointer such as `Box`.
:::

## Closures and iterators

Rust code rarely writes index loops. Like `Array.prototype.map/filter` in TS or LINQ in C#, it chains
**iterator adapters** and passes **closures**:

```rust
let titles: Vec<String> = clips
    .iter()                                   // borrow each clip: yields &Clip
    .filter(|c| c.end_ms - c.start_ms >= 1_000) // keep clips of at least 1 s
    .map(|c| c.title.to_uppercase())          // &Clip -> String
    .collect();                               // run the pipeline, build a Vec
```

**Closures** are `|args| body`. They capture variables from the surrounding scope, and how they
capture decides which trait they implement:

| Trait | The closure… | Can be called |
|---|---|---|
| `Fn` | only reads captured values | many times, even at once |
| `FnMut` | mutates captured values (`count += 1`) | many times, one at a time |
| `FnOnce` | moves a captured value out (gives it away) | once |

`move |x| …` makes the closure **take ownership** of what it captures. You need it when the closure
outlives the current function, for example when you hand it to a thread (see **Concurrency and
async: threads, channels, tokio**).

### Iterators are lazy

This is the biggest difference from JavaScript arrays. In JS, `arr.map(f)` runs `f` immediately and
allocates a new array. In Rust, `.map(f)` builds a *description* of the work and **nothing runs until a
consumer pulls values**. Consumers include `collect`, `sum`, `count`, `for`, `find`, `any` and `last`.

```rust
clips.iter().map(|c| println!("{}", c.title));   // prints nothing!
// warning: unused `Map` that must be used
//   = note: iterators are lazy and do nothing unless consumed
```

```text
source         adapters (lazy)                  consumer (pulls)
clips.iter() → filter(|c| …) → map(|c| …) →    collect::<Vec<_>>()
                                                 │
     ◄──────────── next()? ◄──────── next()? ◄──┘   one item travels the whole chain at a time
```

Each item travels through the whole chain before the next one starts. No intermediate `Vec` is
built, which is why iterator chains compile to the same code as a hand-written loop.

Common adapters: `map`, `filter`, `filter_map` (map + drop `None`s), `enumerate` (adds an index),
`zip`, `take`, `skip`, `chain`, `flat_map`, `rev`. Common consumers: `collect`, `sum`, `count`, `min`, `max`,
`find`, `any`, `all`, `fold`.

**`.iter()` vs `.into_iter()` vs `.iter_mut()`** are ownership again (from **Ownership, borrowing
and lifetimes**). `iter()` yields `&T`, `iter_mut()` yields `&mut T`, and `into_iter()` consumes
the collection and yields `T`.

### `collect` is driven by the type you ask for

`collect()` can build a `Vec`, a `HashMap`, a `String`, and, the most useful trick in the
lesson, a **`Result<Vec<T>, E>` out of an iterator of `Result<T, E>`**:

```rust
let lines = ["Intro,0,1500", "Bad,x,1", "Outro,1500,3000"];

let clips: Result<Vec<Clip>, ClipError> = lines.iter().map(|l| parse_line(l)).collect();
// Ok(vec![…]) if every line parsed;
// Err(first error) otherwise — and it stops pulling after that error.
```

You tell `collect` the target type with a type annotation (`let x: Vec<_>`) or with the
**turbofish**: `.collect::<Result<Vec<_>, _>>()`. The `_` means "compiler, infer this part".

:::quiz id=rs-03-q4 xp=10
`parse_line` prints `"parsing …"` and then parses. What does this program print?

```rust
let lines = ["A,0,10", "B,x,20", "C,20,30"];
let r: Result<Vec<Clip>, ClipError> = lines.iter().map(|l| parse_line(l)).collect();
println!("{}", r.is_ok());
```

- [ ] `parsing A`, `parsing B`, `parsing C`, then `false`
- [x] `parsing A`, `parsing B`, then `false`
- [ ] Only `false`, because iterators are lazy and `collect` doesn't run `map`
- [ ] `parsing A`, `parsing B`, `parsing C`, then `true`, because errors are skipped
> `collect` into `Result` **short-circuits**: it pulls items one by one and stops at the first `Err`,
> so line C is never parsed. `collect` *is* a consumer, so `map` does run (laziness only means nothing
> happens *without* a consumer). Errors are never silently skipped. To skip them, use
> `filter_map(|l| parse_line(l).ok())`.
:::

:::challenge id=rs-03-c1 lang=ts xp=45
title: collect into Result
TypeScript has no `Result`, so `setup` gives you a tiny one (`ok(value)`, `err(error)`, and the
`Result<T, E>` type). Model Rust's iterator behaviour:

1. `collectResults(items)` takes any **iterable** of `Result<T, E>` and returns `ok(values)` if every item
   is ok, or the **first** `err` otherwise. Like Rust, it must **stop pulling** items after the first error
   (the tests use a generator that counts how often it is pulled).
2. `parseDurations(text)` models `parse_project`. Split `text` on `\n`, **keep the real line number**
   (1-based), skip lines that are empty or start with `#` after trimming, and parse each `start,end` pair into
   `end - start`. Errors are strings:
   - not exactly 2 fields → `"line N: expected 2 fields, got K"`
   - a field that isn't a non-negative integer → `"line N: not a number"`
   - `end <= start` → `"line N: end must be after start"`

   Use `collectResults` so the first bad line wins.

hint: Use `for (const r of items) { if (!r.ok) return r; values.push(r.value) }`. Returning early from a `for…of` stops the generator.
hint: Enumerate before filtering: `text.split('\n').map((l, i) => [i + 1, l.trim()] as const)`.
hint: `/^\d+$/.test(s)` checks for a non-negative integer.

```ts setup
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
const ok = <T,>(value: T): Result<T, never> => ({ ok: true, value })
const err = <E,>(error: E): Result<never, E> => ({ ok: false, error })
```

```ts starter
export function collectResults<T, E>(items: Iterable<Result<T, E>>): Result<T[], E> {
  // TODO: Ok(all values) or the first Err, and stop pulling after it
  return ok([])
}

export function parseDurations(text: string): Result<number[], string> {
  // TODO: enumerate → filter → map(parse) → collectResults
  return ok([])
}
```

```ts solution
export function collectResults<T, E>(items: Iterable<Result<T, E>>): Result<T[], E> {
  const values: T[] = []
  for (const r of items) {
    if (!r.ok) return r
    values.push(r.value)
  }
  return ok(values)
}

function parsePair(line: number, text: string): Result<number, string> {
  const parts = text.split(',').map(s => s.trim())
  if (parts.length !== 2) return err(`line ${line}: expected 2 fields, got ${parts.length}`)
  if (!parts.every(p => /^\d+$/.test(p))) return err(`line ${line}: not a number`)
  const [start, end] = parts.map(Number)
  if (end <= start) return err(`line ${line}: end must be after start`)
  return ok(end - start)
}

export function parseDurations(text: string): Result<number[], string> {
  const rows = text
    .split('\n')
    .map((l, i) => [i + 1, l.trim()] as const)
    .filter(([, l]) => l !== '' && !l.startsWith('#'))
  return collectResults(rows.map(([n, l]) => parsePair(n, l)))
}
```

```ts tests
function* counted<T>(items: T[], log: T[]) {
  for (const x of items) { log.push(x); yield x }
}

test('all ok gives ok with every value, in order', () => {
  expect(collectResults([ok(1), ok(2), ok(3)])).toEqual({ ok: true, value: [1, 2, 3] })
})
test('empty input is ok([])', () => {
  expect(collectResults([])).toEqual({ ok: true, value: [] })
})
test('the first error wins', () => {
  expect(collectResults([ok(1), err('A'), err('B')])).toEqual({ ok: false, error: 'A' })
})
test('stops pulling after the first error (short-circuit)', () => {
  const pulled: Result<number, string>[] = []
  const r = collectResults(counted([ok(1), err('boom'), ok(3), ok(4)], pulled))
  expect(r).toEqual({ ok: false, error: 'boom' })
  expect(pulled).toHaveLength(2)
})
test('parseDurations maps each line to end - start', () => {
  expect(parseDurations('0,1500\n1500,61500')).toEqual({ ok: true, value: [1500, 60000] })
})
test('blank lines and # comments are skipped', () => {
  expect(parseDurations('# export\n\n  0,10  \n\n10,30\n')).toEqual({ ok: true, value: [10, 20] })
})
test('errors carry the real line number, not the clip index', () => {
  expect(parseDurations('0,10\n\n# c\nx,20')).toEqual({ ok: false, error: 'line 4: not a number' })
})
test('field count and order errors', () => {
  expect(parseDurations('1,2,3')).toEqual({ ok: false, error: 'line 1: expected 2 fields, got 3' })
  expect(parseDurations('5,5')).toEqual({ ok: false, error: 'line 1: end must be after start' })
  expect(parseDurations('-1,5')).toEqual({ ok: false, error: 'line 1: not a number' })
})
test('first bad line wins in parseDurations too', () => {
  expect(parseDurations('0,10\n9,1\nzz')).toEqual({ ok: false, error: 'line 2: end must be after start' })
})
```
:::

## Modules, visibility and workspaces

### Modules inside one crate

A crate is a tree of **modules**. `mod clip;` in `lib.rs` tells the compiler to look in `src/clip.rs`
(or `src/clip/mod.rs`). Unlike TypeScript, **a file is not a module until a parent declares it** with
`mod`. A file nobody declares is simply not compiled.

```text
crates/clip-core/
├── Cargo.toml
└── src/
    ├── lib.rs        ← crate root:  mod clip;  mod error;  pub use …
    ├── clip.rs       ← crate::clip
    └── error.rs      ← crate::error
```

```rust
// src/lib.rs
mod clip;                        // private module: only this crate can name `crate::clip`
mod error;

pub use clip::{Clip, Project};   // re-export: users write clip_core::Clip, not clip_core::clip::Clip
pub use error::ClipError;
```

**Everything is private by default**: items, fields and modules alike. This is the reverse of TS,
where everything in a file is visible unless you don't export it.

| Visibility | Visible to | C# analogue |
|---|---|---|
| (nothing) | the current module and its children | `private` |
| `pub(crate)` | the whole crate, not other crates | `internal` |
| `pub(super)` | the parent module | (none) |
| `pub` | everyone who can reach the module | `public` |

A `pub struct` with private fields is the Rust way to **enforce invariants**. Outsiders can't build a
`Clip` whose `end_ms < start_ms` if the fields are private and the only constructor validates. They
also can't read a private field: `error[E0616]: field 'duration_ms' of struct 'Clip' is private`.

**Paths:** `crate::clip::Clip` (absolute, from this crate's root), `super::Clip` (the parent module),
`self::helpers` (this module), `clip_core::Clip` (another crate, by its name with `-` replaced by `_`).
`use` brings a path into scope, like `import`. It does not load anything, it only shortens names.

:::quiz id=rs-03-q5 xp=10
Will this compile?

```rust
mod media {
    pub struct Clip { pub title: String }
    fn probe() -> u64 { 42 }
}

fn main() {
    let n = media::probe();
    println!("{n}");
}
```

- [ ] Yes: `main` is in the same file as `media`, so it can see everything.
- [x] No: `error[E0603]: function 'probe' is private`. It needs `pub fn` or `pub(crate) fn`.
- [ ] No: `error[E0433]`, because `media` must be imported with `use media;` first.
- [ ] Yes, but only in debug builds.
> Privacy follows **modules**, not files. `main` is in the crate root, which is the *parent* of
> `media`. A parent can't see its child's private items, but a child can see its parent's. Mark it
> `pub(crate)` when it's meant for this crate only.
:::

### Workspaces: many crates, one repo

Real apps split into crates so that the domain logic compiles and tests without the UI. ClipDesk's
layout, which the lab builds and the Tauri lessons extend:

```text
clipdesk/
├── Cargo.toml          ← [workspace] members, shared dependency versions
├── Cargo.lock          ← ONE lock file for every crate (commit it)
├── target/             ← ONE build folder (gitignore it)
└── crates/
    ├── clip-core/      ← library: parsing, validation, serde types.  Uses thiserror.
    ├── clipdesk-cli/   ← binary: reads files, prints JSON.             Uses anyhow.
    └── (later) src-tauri/ ← the Tauri 2 app crate, depends on clip-core
```

```toml
# clipdesk/Cargo.toml (a "virtual" workspace: no [package] of its own)
[workspace]
members = ["crates/*"]
resolver = "3"                 # the dependency resolver that goes with edition 2024

[workspace.package]
edition = "2024"
version = "0.1.0"

[workspace.dependencies]       # one place to pick versions
serde = { version = "1", features = ["derive"] }
thiserror = "2"
```

A member then writes `serde.workspace = true`. Commands take `-p <package>`: `cargo test -p clip-core`,
`cargo run -p clipdesk-cli`. Plain `cargo test` at the root tests every member.

:::job title="What you'll see at work"
Almost every Rust repo bigger than a toy is a workspace. A typical Tauri project has `src-tauri/` (the
app crate) beside one or more `crates/*` libraries that hold the real logic. Reviewers expect new logic in
the library crate, with tests there. The app crate should be thin glue: commands that call the library
and convert errors. You'll also see `[workspace.dependencies]` so that two crates can't accidentally pull
two major versions of the same dependency.
:::

## Errors for real apps

In **Rust for TypeScript and C# developers** you met `Result<T, E>`, `?` and `unwrap`. A real app
needs more than `Result<T, String>`:

- **The caller must be able to react.** The Tauri UI shows "file not found" differently from "bad clip
  on line 3". A `String` can't be matched on safely.
- **The cause must not be lost.** "could not parse project" is useless without "line 3: not a number:
  invalid digit found in string" underneath it.
- **Converting errors must be cheap to write**, otherwise people write `.unwrap()`.

### The plumbing: `Error`, `Display`, `From` and `?`

An error type in Rust is any type that implements `Debug + Display` and the marker trait
`std::error::Error`. Its optional `source()` method returns the underlying cause, which is how
**error chains** are built.

The `?` operator does more than return early. On `Err(e)` it returns `Err(From::from(e))`.
It **converts** the error into your function's error type, using a `From` implementation:

```rust
#[derive(Debug)]
pub enum ClipError {
    EmptyTitle,
    BadNumber(std::num::ParseIntError),
}

impl From<std::num::ParseIntError> for ClipError {
    fn from(e: std::num::ParseIntError) -> Self { ClipError::BadNumber(e) }
}

fn parse_start(s: &str) -> Result<u64, ClipError> {
    let n = s.parse::<u64>()?;   // ParseIntError → ClipError via From, then early return
    Ok(n)
}
```

Without that `impl From`, the `?` line fails with
``error[E0277]: `?` couldn't convert the error to `ClipError` ``. The compiler adds
``the trait `From<ParseIntError>` is not implemented for `ClipError` ``. That message is the
compiler telling you exactly which conversion to add.

:::quiz id=rs-03-q6 xp=10
`fn parse(s: &str) -> Result<u64, ClipError>` contains `let n = s.parse::<u64>()?;`. `ClipError` is your
own enum with no `From` impls. What happens?
- [ ] It compiles; `?` turns any error into a `String` automatically.
- [ ] It compiles but panics at runtime when the parse fails.
- [x] `error[E0277]: '?' couldn't convert the error to 'ClipError'`, because `From<ParseIntError>` is not implemented for `ClipError`.
- [ ] `error[E0308]: mismatched types`, and the only fix is `.unwrap()`.
> `?` calls `From::from` on the error. Fix it with an `impl From<ParseIntError> for ClipError` (or
> `#[from]` with thiserror), or convert at that spot with `.map_err(ClipError::BadNumber)?`. Rust has no
> implicit conversions: the `From` impl is a deliberate, visible decision.
:::

### thiserror: precise errors for libraries

Writing `Display`, `Error` and the `From` impls by hand is boilerplate. **`thiserror`** (currently
2.x) is a derive macro that writes them, and the generated code is exactly what you'd write by hand.
It adds nothing to your public API.

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ClipError {
    #[error("title is empty")]                                   // Display text
    EmptyTitle,

    #[error("end ({end_ms} ms) must be after start ({start_ms} ms)")] // fields in the message
    EndBeforeStart { start_ms: u64, end_ms: u64 },

    #[error("not a number")]
    BadNumber(#[from] std::num::ParseIntError),                  // From impl + source()

    #[error("line {line}")]
    AtLine { line: usize, #[source] source: Box<ClipError> },    // source() without From

    #[error("invalid project JSON")]
    Json(#[from] serde_json::Error),
}
```

- `#[error("…")]` generates `Display`. `{field}` and `{0}` interpolate fields.
- `#[from]` generates `impl From<T> for ClipError` **and** makes the field the `source()`.
- `#[source]` marks the cause without generating `From`. Use it when you add context (like a line number)
  yourself.
- `#[error(transparent)]` forwards both `Display` and `source()` to the inner error, for "just wrap it" variants.

**Don't print the source in the message.** If `BadNumber` said `#[error("not a number: {0}")]` *and*
returned the `ParseIntError` as its source, every chain printer (anyhow, logging, the test helper in the
lab) would print the cause **twice**. Choose one: the cause goes in `source()`, and the message describes
only this level.

### anyhow: convenient errors for applications

At the top of an application (`main`, a CLI, a background job), you rarely `match` on error types. You
want to **add context and show the whole chain to a human**. That's **`anyhow`** (1.x):

```rust
use anyhow::{bail, Context, Result};   // Result<T> = Result<T, anyhow::Error>

fn run() -> Result<()> {
    let path = std::env::args().nth(1).context("usage: clipdesk-cli <clips.csv>")?; // Option → error
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("could not read {path}"))?;   // io::Error + context
    let project = clip_core::parse_project("demo", &text)
        .with_context(|| format!("could not parse {path}"))?;  // ClipError + context
    if project.clips.is_empty() {
        bail!("{path} contains no clips");                       // early return with a new error
    }
    Ok(())
}
```

`anyhow::Error` accepts **any** `std::error::Error + Send + Sync + 'static`, so `?` works on io, serde and
your own errors without any `From` impls. How it prints:

```text
{err}     could not parse bad.csv
{err:#}   could not parse bad.csv: line 2: not a number: invalid digit found in string
{err:?}   could not parse bad.csv

          Caused by:
              0: line 2
              1: not a number
              2: invalid digit found in string
```

`fn main() -> anyhow::Result<()>` prints `Error: ` followed by the `{:?}` form, and exits with code 1 on
error. With only **one** cause, anyhow leaves out the number: `Caused by:` then the cause, indented by 4 spaces.

### Which one where?

| | `thiserror` | `anyhow` |
|---|---|---|
| Goal | Callers can **match** on what went wrong | A human can **read** what went wrong |
| Use in | Library crates (`clip-core`), public APIs, anything the UI branches on | Binaries, CLIs, `main`, scripts, tests |
| Error type | Your own `enum` | One opaque `anyhow::Error` |
| Adding context | A variant with fields (`AtLine { line, source }`) | `.context("…")` / `.with_context(\|\| …)` |
| C# analogue | Specific exception classes | `throw new Exception("…", inner)` |

Both are often in the same workspace: `clip-core` returns `ClipError`, and `clipdesk-cli` wraps it with
anyhow context. A library that returns `anyhow::Error` forces every caller to parse strings to tell
errors apart, which is why reviewers push back on it.

:::warn title="Tauri commands need serializable errors"
Everything a Tauri command returns travels to the TypeScript frontend as JSON, **including errors**. The
Tauri 2 docs say everything a command returns must implement `serde::Serialize`, errors included. `ClipError`
(and the `ParseIntError` and `serde_json::Error` inside it) doesn't implement `Serialize`, so the usual pattern is a hand-written impl that sends the message:

```rust
impl serde::Serialize for ClipError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
```

`anyhow::Error` isn't `Serialize` either. Return your own error type from commands, not anyhow. The
full command story is in **Tauri 2: a desktop app with a web frontend**.
:::

:::quiz id=rs-03-q7 xp=10
Which statements about error handling are good practice? (Select all that apply.)
- [x] `clip-core` (a library) defines `ClipError` with thiserror so the Tauri app can `match` on `EndBeforeStart`.
- [x] `clipdesk-cli` uses `anyhow::Result` and `.with_context(|| format!("could not read {path}"))`.
- [ ] `clip-core`'s public functions return `anyhow::Result` so callers don't need to know the error type.
- [ ] `#[error("not a number: {0}")] BadNumber(#[from] ParseIntError)` is the clearest way to show the cause.
- [x] A Tauri command returns `Result<Project, ClipError>` where `ClipError` implements `serde::Serialize`.
> Libraries expose typed errors and applications add human context. A library returning anyhow makes callers
> parse strings. Putting `{0}` in the message *and* using `#[from]` (which makes it the `source()`) prints
> the cause twice in any chain (`{:#}`, `{:?}`, logs). Tauri serializes command errors, so they must be `Serialize`.
:::

:::challenge id=rs-03-c2 lang=ts xp=45
title: Error chains like anyhow
Model Rust's error chains. An `ErrorNode` has a `message` (its `Display`) and an optional `source`
(the cause). Write:

1. `context(source, message)`: returns a new node wrapping `source` (like `.context("…")`).
2. `chainAlternate(err)`: the `{:#}` form, every message from outer to inner joined with `": "`.
3. `chainDebug(err)`: the `{:?}` form. Return the outer message alone if there is no source, otherwise:
   ```text
   outer

   Caused by:
       0: next
       1: root
   ```
   (a blank line, `Caused by:`, then each cause on its own line indented by 4 spaces, numbered from 0).
   Like anyhow, leave the numbers out when there is **only one** cause: `outer\n\nCaused by:\n    root`.
4. `duplicatedLevels(err)`: the 0-based depths whose message **ends with** `": " + <its source's message>`.
   That is the "printed the cause twice" mistake from the lesson. It returns `[]` for a clean chain.

hint: Walk the chain with `let cur: ErrorNode | undefined = err; while (cur) { …; cur = cur.source }`.
hint: `chainDebug`: messages = all levels; `[first, ...causes]`; `causes.map((m, i) => '    ' + (causes.length > 1 ? i + ': ' : '') + m)`.

```ts setup
interface ErrorNode { message: string; source?: ErrorNode }
const leaf = (message: string): ErrorNode => ({ message })
```

```ts starter
export function context(source: ErrorNode, message: string): ErrorNode {
  return { message }
}

export function chainAlternate(err: ErrorNode): string {
  return err.message
}

export function chainDebug(err: ErrorNode): string {
  return err.message
}

export function duplicatedLevels(err: ErrorNode): number[] {
  return []
}
```

```ts solution
function messages(err: ErrorNode): string[] {
  const out: string[] = []
  let cur: ErrorNode | undefined = err
  while (cur) { out.push(cur.message); cur = cur.source }
  return out
}

export function context(source: ErrorNode, message: string): ErrorNode {
  return { message, source }
}

export function chainAlternate(err: ErrorNode): string {
  return messages(err).join(': ')
}

export function chainDebug(err: ErrorNode): string {
  const [first, ...causes] = messages(err)
  if (causes.length === 0) return first
  const numbered = causes.length > 1
  return [first, '', 'Caused by:', ...causes.map((m, i) => `    ${numbered ? `${i}: ` : ''}${m}`)].join('\n')
}

export function duplicatedLevels(err: ErrorNode): number[] {
  const out: number[] = []
  let cur: ErrorNode | undefined = err
  let depth = 0
  while (cur) {
    if (cur.source && cur.message.endsWith(': ' + cur.source.message)) out.push(depth)
    cur = cur.source
    depth++
  }
  return out
}
```

```ts tests
const cli = () =>
  context(context(context(leaf('invalid digit found in string'), 'not a number'), 'line 2'), 'could not parse bad.csv')

test('context wraps the source', () => {
  const e = context(leaf('root'), 'outer')
  expect(e.message).toBe('outer')
  expect(e.source).toEqual({ message: 'root' })
})
test('{:#} joins the chain with ": "', () => {
  expect(chainAlternate(cli())).toBe('could not parse bad.csv: line 2: not a number: invalid digit found in string')
  expect(chainAlternate(leaf('alone'))).toBe('alone')
})
test('{:?} prints a Caused by: list numbered from 0', () => {
  expect(chainDebug(cli())).toBe(
    'could not parse bad.csv\n\nCaused by:\n    0: line 2\n    1: not a number\n    2: invalid digit found in string'
  )
})
test('{:?} with a single cause leaves out the number', () => {
  expect(chainDebug(context(leaf('root'), 'outer'))).toBe('outer\n\nCaused by:\n    root')
})
test('{:?} without a source is just the message', () => {
  expect(chainDebug(leaf('title is empty'))).toBe('title is empty')
})
test('a clean chain has no duplicated levels', () => {
  expect(duplicatedLevels(cli())).toEqual([])
})
test('finds levels that repeat their source in the message', () => {
  const root = leaf('invalid digit found in string')
  const bad = context(context(root, 'not a number: invalid digit found in string'), 'line 2')
  expect(duplicatedLevels(bad)).toEqual([1])
  const worse = context(bad, 'could not parse: line 2')
  expect(duplicatedLevels(worse)).toEqual([0, 2])
})
```
:::

## serde: structs to JSON and back

**serde** (SERialize/DEserialize) is the de facto standard for data formats in Rust. The derive
macros generate code at compile time, with no reflection, and format crates plug in: `serde_json`,
`toml`, `postcard`, `rmp-serde` (MessagePack) and others. Tauri uses serde for every command argument and return value.

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]                       // start_ms ↔ "startMs" for the TS side
pub struct Clip {
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] // missing → empty; empty → omitted
    pub tags: Vec<String>,
}

let json = serde_json::to_string_pretty(&clip)?;          // Clip → String
let back: Clip = serde_json::from_str(&json)?;            // String → Clip (validated!)
let any: serde_json::Value = serde_json::from_str(r#"{"x":1}"#)?; // untyped, like JSON.parse
```

Useful attributes:

| Attribute | Effect |
|---|---|
| `#[serde(rename_all = "camelCase")]` | Field names follow JS conventions in JSON |
| `#[serde(rename = "type")]` | One field gets a different JSON name (`type` is a Rust keyword) |
| `#[serde(default)]` | A missing field uses `Default::default()` instead of failing |
| `#[serde(skip_serializing_if = "Option::is_none")]` | Omit empty values |
| `#[serde(tag = "kind")]` on an enum | Internally tagged: `{"kind":"Gif","fps":12}`, which maps to a TS discriminated union |
| `#[serde(deny_unknown_fields)]` | Reject JSON with extra keys (strict config files) |

**Deserialization is validation.** `serde_json::from_str::<Clip>` fails with a precise message when a
field is missing or has the wrong type (``missing field `title` at line 1 column 20``). That's a big
change from `JSON.parse(x) as Clip` in TypeScript, which checks nothing.

:::quiz id=rs-03-q8 xp=10
`Clip` has `#[serde(rename_all = "camelCase")]` and a field `pub tags: Vec<String>` **without** `#[serde(default)]`.
What does `serde_json::from_str::<Clip>(r#"{"title":"Intro","startMs":0,"endMs":1500}"#)` return?
- [ ] `Ok(Clip { tags: vec![], .. })`, because missing `Vec`s are always empty.
- [x] `Err(...)` with a message like ``missing field `tags` ``.
- [ ] `Ok`, but `tags` is uninitialized memory.
- [ ] It doesn't compile because `Vec<String>` can't be deserialized.
> Without `#[serde(default)]`, every non-`Option` field is required. (`Option<T>` fields are the exception:
> a missing one becomes `None`.) Add `#[serde(default)]` to accept older files that don't have the
> field yet. That's how you evolve a saved-project format without breaking users' existing files.
:::

## Testing, clippy and rustfmt

Cargo has testing built in, with no Jest or xUnit to install. There are three kinds of test:

```rust
// 1. UNIT TESTS: in the same file, can test private functions.
#[cfg(test)]              // compiled only for `cargo test`, not in release builds
mod tests {
    use super::*;         // everything from the parent module, private items included

    #[test]
    fn rejects_end_before_start() {
        let err = parse_line("Oops,2000,1000").unwrap_err();
        assert!(matches!(err, ClipError::EndBeforeStart { start_ms: 2000, .. }));
    }

    #[test]
    #[should_panic(expected = "attempt to subtract with overflow")]
    fn duration_overflows_in_debug() { /* … */ }
}
```

```text
crates/clip-core/
├── src/lib.rs              ← unit tests live here, in #[cfg(test)] mod tests
└── tests/                  ← 2. INTEGRATION TESTS: each file is its own crate,
    └── project.rs             sees only the PUBLIC API (use clip_core::…)
```

```rust
/// 3. DOC TESTS: code in /// comments is compiled and run by `cargo test`.
///
/// ```
/// let clip = clip_core::parse_line("Intro,0,1500").unwrap();
/// assert_eq!(clip.duration_ms(), 1500);
/// ```
pub fn parse_line(line: &str) -> Result<Clip, ClipError> { /* … */ }
```

Doc tests keep the examples in your docs honest. If the API changes, the example fails the build.

Handy commands: `cargo test` (all), `cargo test -p clip-core`, `cargo test first_bad` (name filter),
`cargo test -- --nocapture` (show `println!` output), `cargo test --doc`.

**`cargo fmt`** (rustfmt) formats the code. There is one official style, so formatting is never
debated in review. `cargo fmt --check` fails CI if a file isn't formatted.

**`cargo clippy`** is the official linter, with hundreds of lints such as these real ones:

```text
warning: length comparison to zero                    clippy::len_zero           (use .is_empty())
warning: writing `&Vec` instead of `&[_]` …           clippy::ptr_arg            (take a slice)
warning: the loop variable `i` is only used to index  clippy::needless_range_loop (use an iterator)
```

Clippy is the fastest way to learn idiomatic Rust: read every warning it gives you.

:::pro title="The CI line every Rust repo has"
```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets --all-features -- -D warnings && cargo test --workspace
```
`--all-targets` also lints tests and examples. `-D warnings` turns warnings into errors **in CI only**,
so a new compiler release adding a lint doesn't break everyone's local builds. Teams pin the toolchain with
a `rust-toolchain.toml` (`[toolchain] channel = "1.xx"`) so that CI and laptops use the same clippy.
**Shipping: bundles, signing, auto-update and CI** puts this into a GitHub Actions workflow.
:::

:::quiz id=rs-03-q9 xp=10
You want to test the private helper `fn split_fields(line: &str)` in `clip-core/src/lib.rs`. Where does the test go?
- [ ] In `crates/clip-core/tests/split.rs`, because all tests belong in `tests/`.
- [x] In a `#[cfg(test)] mod tests { use super::*; … }` block inside `lib.rs`.
- [ ] In a doc comment on `split_fields`, because doc tests can call private items.
- [ ] Nowhere: private functions can't be tested in Rust.
> Unit tests are a child module of the code under test, and children can see their parent's private items.
> Integration tests in `tests/` are separate crates that link `clip_core` like any user would, so they see
> only `pub` items. That's the point: they test the public API. Doc tests also run as an external crate.
:::

## Supply chain: Cargo.lock, cargo audit, cargo deny

A Tauri app pulls in **hundreds** of crates. Each one is code that runs on your users' machines,
with your app's permissions. You need to know exactly which versions you ship, and when one of them has a
known vulnerability.

**`Cargo.toml` vs `Cargo.lock`.** `serde = "1"` in `Cargo.toml` means "any 1.x ≥ 1.0.0" (caret
semver, like `^1` in npm). `Cargo.lock` records the **exact** version and checksum of every crate in the
graph, so every build is reproducible. Commit it for apps. Since 2023 the Cargo team no longer tells
libraries to leave it out: committing it is the suggested starting point for every project, and `cargo new`
no longer gitignores it. `cargo update` moves to newer compatible versions;
`cargo update -p serde_json` updates just one. In CI, `cargo build --locked` fails if the lock file would change.

**RustSec** is the community advisory database for crates (rustsec.org). Two tools read it:

```bash
cargo install cargo-audit --locked
cargo audit                      # checks Cargo.lock against RustSec; non-zero exit on a vulnerability

cargo install cargo-deny --locked
cargo deny init                  # writes a commented deny.toml
cargo deny check                 # advisories + bans (duplicates, banned crates) + licenses + sources
```

`cargo audit` answers one question: "do I depend on a known-vulnerable version?". `cargo deny` is the
policy tool. It also enforces **licenses** (no GPL in a closed-source app, for example), **bans** (forbid a
crate, flag duplicate versions) and **sources** (only crates.io, no random git repos).

To find out who pulls a crate in, ask the dependency tree in reverse:

```bash
cargo tree -i some-crate          # -i = invert: who depends on some-crate?
cargo tree -d                     # duplicate versions of the same crate
```

### When the fix is blocked upstream

The common real-world case is that an advisory hits a crate **deep in the tree**. A patched version
exists, but the crate between you and it (say, a GUI dependency of a dependency) still requires the old
major version. `cargo update` can't help, because semver forbids the jump.

```text
clipdesk ─► some-framework 2.x ─► helper 0.4 ─► vulnerable-crate 0.8   (fix only in 0.9)
                                                      ▲
                                   helper's Cargo.toml says "0.8", so cargo can't pick 0.9
```

What a senior does, in order:

1. **Read the advisory.** Which function is affected, and on which platform? Many advisories hit code
   paths your app never calls, or only one OS.
2. **`cargo tree -i vulnerable-crate`** to see the exact path, and check whether an upstream release or open PR
   already fixes it. Upgrading the *top* crate often solves it.
3. If you're affected and upstream is slow, **patch it**: fork, bump, and override with `[patch.crates-io]`
   in the workspace `Cargo.toml`. Report it or send the PR upstream.
4. If you're **not** affected, **ignore it with a written reason and a link**, so that the exception is visible
   and gets reviewed:

```toml
# deny.toml
[advisories]
ignore = [
  { id = "RUSTSEC-0000-0000", reason = "only affects the X11 backend we don't ship; tracked in issue #123, remove after helper 0.5" },
]
```

```toml
# .cargo/audit.toml (cargo audit's equivalent; or one-off: cargo audit --ignore RUSTSEC-0000-0000)
[advisories]
ignore = ["RUSTSEC-0000-0000"]
```

5. **Revisit it.** cargo-deny warns about an `ignore` entry that no longer matches anything (`unused-ignored-advisory`),
   which is your signal to delete it after the upstream fix lands.

Never silence the whole check (`continue-on-error: true` in CI). Then the next, real vulnerability goes
unnoticed too.

:::quiz id=rs-03-q10 xp=10
`cargo audit` reports `RUSTSEC-0000-0000` in `vulnerable-crate 0.8.3`, pulled in through two other crates
you don't control. The fix exists only in 0.9. What are reasonable steps? (Select all that apply.)
- [x] Run `cargo tree -i vulnerable-crate` to see which dependency pins 0.8.
- [x] Read the advisory to check whether your app ever reaches the affected code or platform.
- [x] If you're not affected, add an `ignore` entry with a reason and a tracking link, and remove it when upstream updates.
- [ ] Delete `Cargo.lock` and rebuild. That always picks the newest versions.
- [ ] Set the CI audit step to `continue-on-error: true` so it stops blocking merges.
> Deleting the lock file can't cross a semver boundary that an intermediate crate requires. It also throws
> away your reproducible build. Disabling the check hides *future* advisories as well. Trace the path, assess
> the impact, then patch (`[patch.crates-io]`, upstream PR) or document a scoped, temporary ignore.
:::

:::lab id=rs-03-lab1 xp=110
title: clip-core and clipdesk-cli
Build ClipDesk's first workspace: a **library crate** `clip-core` with a thiserror error enum, serde types and
iterator-based parsing, and a **binary crate** `clipdesk-cli` that uses anyhow to read a CSV file and
print JSON. It has unit, integration and doc tests, and finishes with clippy, rustfmt and cargo audit.
Works on Linux, macOS and Windows with **Rust stable** (edition 2024 needs Rust 1.85+; tested with
1.97, thiserror 2.0, serde 1.0, anyhow 1.0, November 2026).

**1. Create the workspace**

```bash
rustup update stable
mkdir clipdesk && cd clipdesk
git init
```

Create `clipdesk/Cargo.toml`:

```toml
[workspace]
members = ["crates/*"]
resolver = "3"

[workspace.package]
edition = "2024"
version = "0.1.0"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
anyhow = "1"
```

Then create the two crates and a `.gitignore`:

```bash
cargo new --lib crates/clip-core
cargo new crates/clipdesk-cli
mkdir crates/clip-core/tests
echo "/target" > .gitignore
```

:::info
`cargo new` inside a git repo doesn't create a nested repository. In Windows PowerShell 5.1, `echo … >`
writes UTF-16, so use `Set-Content .gitignore "/target"` there to get a plain-text file (PowerShell 7's `>`
already writes UTF-8).
:::

**2. Manifests.** Replace `crates/clip-core/Cargo.toml`:

```toml
[package]
name = "clip-core"
version.workspace = true
edition.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
```

Replace `crates/clipdesk-cli/Cargo.toml`:

```toml
[package]
name = "clipdesk-cli"
version.workspace = true
edition.workspace = true

[dependencies]
clip-core = { path = "../clip-core" }
anyhow.workspace = true
```

**3. The error type**: `crates/clip-core/src/error.rs`

```rust
use std::num::ParseIntError;

use thiserror::Error;

/// Every way clip-core can fail. Callers can `match` on it.
#[derive(Debug, Error)]
pub enum ClipError {
    #[error("expected 3 fields (title,start_ms,end_ms), got {0}")]
    WrongFieldCount(usize),

    #[error("title is empty")]
    EmptyTitle,

    // #[from] writes `impl From<ParseIntError> for ClipError`, so `?` converts.
    // The message does NOT repeat the cause: source() already carries it.
    #[error("not a number")]
    BadNumber(#[from] ParseIntError),

    #[error("end ({end_ms} ms) must be after start ({start_ms} ms)")]
    EndBeforeStart { start_ms: u64, end_ms: u64 },

    #[error("line {line}")]
    AtLine {
        line: usize,
        #[source]
        source: Box<ClipError>,
    },

    #[error("invalid project JSON")]
    Json(#[from] serde_json::Error),
}
```

`AtLine` holds a `Box<ClipError>` because an enum can't contain itself directly. Its size would be
infinite (``error[E0072]: recursive type `ClipError` has infinite size``). The `Box` puts the inner error on the heap.

**4. The data types**: `crates/clip-core/src/clip.rs`

```rust
use serde::{Deserialize, Serialize};

use crate::ClipError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")] // start_ms -> "startMs" for the TypeScript frontend
pub struct Clip {
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl Clip {
    pub fn duration_ms(&self) -> u64 {
        self.end_ms - self.start_ms
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub clips: Vec<Clip>,
}

impl Project {
    pub fn total_ms(&self) -> u64 {
        self.clips.iter().map(Clip::duration_ms).sum()
    }

    pub fn to_json(&self) -> Result<String, ClipError> {
        Ok(serde_json::to_string_pretty(self)?)
    }

    pub fn from_json(json: &str) -> Result<Self, ClipError> {
        Ok(serde_json::from_str(json)?)
    }
}
```

**5. The crate root, parsing and unit tests**: replace `crates/clip-core/src/lib.rs`

```rust
//! clip-core: the domain logic of ClipDesk. No UI, no files, no printing.

mod clip;
mod error;

pub use clip::{Clip, Project};
pub use error::ClipError;

/// Parses one `title,start_ms,end_ms` line into a [`Clip`].
///
/// ```
/// let clip = clip_core::parse_line("Intro,0,1500").unwrap();
/// assert_eq!(clip.title, "Intro");
/// assert_eq!(clip.duration_ms(), 1500);
/// ```
pub fn parse_line(line: &str) -> Result<Clip, ClipError> {
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    let [title, start, end] = parts.as_slice() else {
        return Err(ClipError::WrongFieldCount(parts.len()));
    };
    if title.is_empty() {
        return Err(ClipError::EmptyTitle);
    }
    let start_ms: u64 = start.parse()?; // ParseIntError -> ClipError via From
    let end_ms: u64 = end.parse()?;
    if end_ms <= start_ms {
        return Err(ClipError::EndBeforeStart { start_ms, end_ms });
    }
    Ok(Clip {
        title: title.to_string(),
        start_ms,
        end_ms,
        tags: Vec::new(),
    })
}

/// Parses every non-empty line. The first bad line stops the parse.
pub fn parse_project(name: &str, text: &str) -> Result<Project, ClipError> {
    let clips = text
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l.trim()))
        .filter(|(_, l)| !l.is_empty() && !l.starts_with('#'))
        .map(|(line, l)| {
            parse_line(l).map_err(|e| ClipError::AtLine {
                line,
                source: Box::new(e),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Project {
        name: name.to_string(),
        clips,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_valid_line() {
        let c = parse_line(" Intro , 0 , 1500 ").unwrap();
        assert_eq!(c.title, "Intro");
        assert_eq!((c.start_ms, c.end_ms), (0, 1500));
    }

    #[test]
    fn rejects_end_before_start() {
        let err = parse_line("Oops,2000,1000").unwrap_err();
        assert!(matches!(
            err,
            ClipError::EndBeforeStart {
                start_ms: 2000,
                end_ms: 1000
            }
        ));
    }

    #[test]
    fn bad_number_converts_through_from() {
        let err = parse_line("Intro,zero,1500").unwrap_err();
        assert!(matches!(err, ClipError::BadNumber(_)));
        assert_eq!(err.to_string(), "not a number");
    }

    #[test]
    fn wrong_field_count() {
        assert!(matches!(
            parse_line("just a title"),
            Err(ClipError::WrongFieldCount(1))
        ));
    }
}
```

Note `let [title, start, end] = parts.as_slice() else { … }`. This is a *let-else* with a slice pattern: it
matches only when there are exactly three fields, and otherwise runs the `else` block, which must return.

**6. Integration tests** (public API only): `crates/clip-core/tests/project.rs`

```rust
use std::error::Error;

use clip_core::{ClipError, Project, parse_project};

/// "outer: inner: root" — the same chain anyhow prints with {:#}.
fn chain(err: &dyn Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut cur = err.source();
    while let Some(e) = cur {
        parts.push(e.to_string());
        cur = e.source();
    }
    parts.join(": ")
}

const SAMPLE: &str = "# ClipDesk export\nIntro,0,1500\n\nInterview,1500,61500\nOutro,61500,64000\n";

#[test]
fn parses_a_project_and_sums_durations() {
    let p = parse_project("demo", SAMPLE).unwrap();
    assert_eq!(p.clips.len(), 3);
    assert_eq!(p.total_ms(), 64_000);
}

#[test]
fn first_bad_line_wins_with_the_real_line_number() {
    let err = parse_project("demo", "Intro,0,1500\n\nBad,x,1\nWorse,9,1\n").unwrap_err();
    assert!(matches!(err, ClipError::AtLine { line: 3, .. }));
    assert_eq!(
        chain(&err),
        "line 3: not a number: invalid digit found in string"
    );
}

#[test]
fn json_round_trip_is_lossless() {
    let p = parse_project("demo", SAMPLE).unwrap();
    let json = p.to_json().unwrap();
    assert!(
        json.contains("\"startMs\": 0"),
        "camelCase for the frontend: {json}"
    );
    assert!(!json.contains("tags"), "empty tags are skipped");
    let back = Project::from_json(&json).unwrap();
    assert_eq!(back, p);
}

#[test]
fn broken_json_is_a_typed_error() {
    let err = Project::from_json(r#"{ "name": 1, "clips": [] }"#).unwrap_err();
    assert!(matches!(err, ClipError::Json(_)));
}
```

**7. The application**: replace `crates/clipdesk-cli/src/main.rs`

```rust
use std::{env, fs, process::ExitCode};

use anyhow::{Context, Result, bail};

fn run() -> Result<()> {
    let path = env::args()
        .nth(1)
        .context("usage: clipdesk-cli <clips.csv>")?;
    let text = fs::read_to_string(&path).with_context(|| format!("could not read {path}"))?;
    let project = clip_core::parse_project("demo", &text)
        .with_context(|| format!("could not parse {path}"))?;
    if project.clips.is_empty() {
        bail!("{path} contains no clips");
    }
    println!("{}", project.to_json()?);
    eprintln!(
        "{} clips, {} ms total",
        project.clips.len(),
        project.total_ms()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}
```

**8. Test, lint, format**

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

Expected `cargo test` output (hashes and timings vary):

```text
     Running unittests src/lib.rs (target/debug/deps/clip_core-…)
running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running tests/project.rs (target/debug/deps/project-…)
running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
     Running unittests src/main.rs (target/debug/deps/clipdesk_cli-…)
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
   Doc-tests clip_core
running 1 test
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Clippy finishes with no warnings, and `cargo fmt --all --check` prints nothing and exits with 0.

**9. Run it**

Create `clips.csv` in the workspace root:

```text
# demo
Intro,0,1500
Interview,1500,61500
```

```bash
cargo run -q -p clipdesk-cli -- clips.csv
```

```text
{
  "name": "demo",
  "clips": [
    {
      "title": "Intro",
      "startMs": 0,
      "endMs": 1500
    },
    {
      "title": "Interview",
      "startMs": 1500,
      "endMs": 61500
    }
  ]
}
2 clips, 61500 ms total
```

Now the error paths. Create `bad.csv` containing the two lines `Intro,0,1500` and `Bad,abc,10`, then:

```bash
cargo run -q -p clipdesk-cli -- bad.csv     # error: could not parse bad.csv: line 2: not a number: invalid digit found in string
cargo run -q -p clipdesk-cli -- nope.csv    # error: could not read nope.csv: No such file or directory (os error 2)
cargo run -q -p clipdesk-cli                # error: usage: clipdesk-cli <clips.csv>
```

Each exits with code 1 (`echo $?` on Linux/macOS, `$LASTEXITCODE` in PowerShell). The Windows wording of the
io error differs ("The system cannot find the file specified. (os error 2)").

**10. Break it on purpose** (undo each change afterwards)

- In `error.rs`, change `#[error("not a number")]` to `#[error("not a number: {0}")]`. `cargo test` now fails
  `bad_number_converts_through_from` (and, with `cargo test --no-fail-fast`, the chain test too). Running `bad.csv`
  prints `invalid digit found in string` **twice**, which is the duplicated-cause mistake.
- Remove `#[from]` from `BadNumber` (leave the field). The `?` on `start.parse()` fails with
  ``error[E0277]: `?` couldn't convert the error to `ClipError` ``.
- In `parse_project`, filter first and enumerate afterwards (`.filter(…).enumerate()`). The integration test
  fails because the error now says `line 2` (the clip index), not the real line 3.
- Remove `PartialEq` from `Project`'s derive. `assert_eq!(back, p)` fails with `error[E0369]`.
- Change `mod clip;` to nothing (delete the line). You get unresolved imports (`E0432`), because a file isn't
  compiled until a parent module declares it.

**11. Supply-chain check**

```bash
cargo install cargo-audit --locked
cargo audit
cargo tree -p clip-core --depth 1
```

`cargo audit` fetches the RustSec database and should report no vulnerabilities for this small graph. (If an
advisory appears, practise the "blocked upstream" steps from the lesson.) `cargo tree` shows `serde`,
`serde_json` and `thiserror` as the only direct dependencies. Commit `Cargo.lock`:

```bash
git add . && git commit -m "clip-core + clipdesk-cli workspace"
```

:::tip
Optional: `cargo install cargo-deny --locked && cargo deny init && cargo deny check`. The generated `deny.toml`
has an empty license allow-list (the examples in it are commented out), so `licenses` fails until you set
`allow = ["MIT", "Apache-2.0", "Unicode-3.0"]` (the licenses this graph uses). Your own two crates fail too
(`error[unlicensed]`), because their manifests have no `license` field. Either add one, or mark them
`publish = false` and set `ignore = true` under `[licenses.private]`. Then all four checks report `ok`.
That is the point of the check: you decide what's acceptable.
:::

- [ ] `cargo test` reports 4 unit tests, 4 integration tests and 1 doc test passing
- [ ] `cargo clippy --all-targets -- -D warnings` and `cargo fmt --all --check` both succeed
- [ ] `cargo run -p clipdesk-cli -- clips.csv` prints camelCase JSON and "2 clips, 61500 ms total"
- [ ] `bad.csv` prints the full chain `could not parse bad.csv: line 2: not a number: invalid digit found in string` and exits with 1
- [ ] Every "break it on purpose" change failed the way described, and you reverted each one
- [ ] `cargo audit` ran and `Cargo.lock` is committed
:::

## How it breaks in practice

- **"No method named `context`" / "no method named `write_all`".** The trait isn't in scope. Add
  `use anyhow::Context;` / `use std::io::Write;`. The compiler suggests the exact `use`, so read it.
- **The cause is printed twice.** `#[error("…: {0}")]` plus `#[from]`/`#[source]`. Keep messages to one level and
  let chain printers (`{:#}`, `{:?}`, tracing) walk `source()`.
- **`.unwrap()` everywhere.** It works until a user opens a malformed project file and the desktop app
  crashes with no message. Use `?` in library code. Allow `unwrap` only in tests, or where an invariant
  truly can't fail (and then use `.expect("why it can't fail")`).
- **An iterator chain that does nothing.** `clips.iter().map(|c| save(c));` with no consumer saves nothing.
  The compiler warns (`unused 'Map' that must be used`), so don't ignore warnings. Use a `for` loop for side effects.
- **`anyhow` leaks into the library.** The UI can no longer tell "file missing" from "bad clip" without
  string matching. Keep `thiserror` enums at library boundaries.
- **A frontend field is always `undefined`.** The Rust struct serializes `start_ms` while the TS code reads
  `startMs`. Add `#[serde(rename_all = "camelCase")]`, and keep one JSON round-trip test per type you send.
- **Old saved files fail to load after an update.** A new non-`Option` field was added without `#[serde(default)]`.
- **The build compiles slowly and the binary is huge.** A generic function is used with dozens of types, or a
  derive-heavy crate is pulled in for one helper. `cargo tree -d` shows duplicate versions, and
  `cargo build --timings` shows where the time goes.
- **CI red on Monday with no code change.** A new RustSec advisory was published. That's the system working.
  Follow the blocked-upstream steps rather than disabling the check.
- **"works on my machine" dependency drift.** Someone deleted or gitignored `Cargo.lock`. Commit it and build
  with `--locked` in CI.

:::cards id=rs-03-cards1 xp=15 title="Traits, errors and crates"
Q: What is the orphan rule?
A: You may `impl Trait for Type` only if the trait or the type is defined in your crate. Wrap foreign types in a
   newtype (`struct Timeline(Vec<Clip>)`) to work around it.
Q: Why can't you derive `Display`?
A: It's the user-facing text, and the compiler can't guess it, so std has no derive for it. `Debug` (developer
   output) can be derived. thiserror's `#[error("…")]` writes `Display` from a format string you supply.
Q: What does `T: PartialOrd` in `fn largest<T: PartialOrd>` do?
A: It's a trait bound. The body may use `<`/`>` on `T`, and callers must pass comparable types.
Q: `impl Trait` vs `dyn Trait`?
A: `impl Trait` (or generics) means one concrete type known at compile time, with static dispatch.
   `dyn Trait` is a trait object behind a pointer: mixed types at runtime, dispatched through a vtable.
Q: What does E0038 "not dyn compatible" mean?
A: The trait can't be a trait object, for example because it has generic methods or returns `Self`.
Q: Are Rust iterators eager or lazy?
A: Lazy. Adapters (`map`, `filter`) do nothing until a consumer (`collect`, `sum`, `for`) pulls items.
Q: What does `collect::<Result<Vec<_>, _>>()` do?
A: It turns an iterator of `Result<T, E>` into `Ok(Vec<T>)`, or the first `Err`, and stops at that error.
Q: What does `?` do with an error?
A: It returns early with `Err(From::from(e))`, converting the error into the function's error type.
Q: thiserror or anyhow?
A: thiserror for libraries (typed enums callers can match on), anyhow for applications (context + chains for humans).
Q: `{err:#}` on an anyhow error?
A: The whole chain on one line: `outer: inner: root`. `{err:?}` prints a "Caused by:" list.
Q: `pub(crate)` means?
A: Visible anywhere in this crate but not to other crates, like C# `internal`.
Q: Unit vs integration vs doc tests?
A: Unit: `#[cfg(test)] mod tests` in the same file, can see private items. Integration: `tests/*.rs`, public API only.
   Doc: code blocks in `///` comments, compiled and run by `cargo test`.
Q: cargo audit vs cargo deny?
A: cargo audit checks Cargo.lock against RustSec advisories. cargo deny also enforces licenses, bans/duplicates
   and allowed sources.
Q: An advisory fix is blocked upstream. What do you do?
A: `cargo tree -i` to find the path and read the advisory's scope. Then upgrade the top crate, patch via
   `[patch.crates-io]`, or add a documented, tracked `ignore`. Never disable the check.
:::

## Recap

- **Traits** are nominal interfaces implemented in separate `impl` blocks, with default methods; the **orphan
  rule** keeps implementations unambiguous. **Derive** `Debug`, `Clone`, `PartialEq` and `Serialize`/`Deserialize`;
  write `Display` yourself.
- **Generics** are checked against their **trait bounds** (`T: PartialOrd`, `where` clauses) and monomorphized
  into fast code. Use **`impl Trait`** by default and **`dyn Trait`** for runtime-mixed types.
- **Closures + iterators** replace index loops. Iterators are **lazy**, and `collect` can build a `Vec`, a `HashMap`
  or a short-circuiting **`Result<Vec<_>, _>`**.
- **Modules** are declared with `mod` and are private by default (`pub`, `pub(crate)`). **Workspaces** share one
  `Cargo.lock` and `target/`, and keep logic in library crates with thin app crates.
- **Errors:** `?` converts with `From`. Use **thiserror** enums in libraries and **anyhow** + `.context()` in apps.
  Don't print the source in the message. Tauri command errors must be `Serialize`.
- **serde** derives JSON (de)serialization. `rename_all = "camelCase"` suits the TS frontend, `default` lets a
  format evolve, and deserializing validates the input.
- **`cargo test`** runs unit, integration and doc tests. **clippy** and **rustfmt** run in CI with `-D warnings` and `--check`.
- **Supply chain:** commit `Cargo.lock`, run **cargo audit** / **cargo deny**. When a fix is blocked upstream, trace,
  assess, then patch or add a documented, temporary ignore.
