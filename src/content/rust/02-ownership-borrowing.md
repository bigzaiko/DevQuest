---
id: rs-02
title: Ownership, borrowing and lifetimes
level: beginner
minutes: 110
xp: 120
summary: The idea that makes Rust Rust — who owns a value, who may read or change it, and for how long — told through real rustc errors and how to fix them.
---

In **Rust for TypeScript and C# developers** you wrote functions, structs and enums, and the
compiler mostly said yes. This lesson is about the times it says **no**. Almost every Rust beginner
spends the first weeks arguing with the *borrow checker*, the part of the compiler that tracks who
owns each value and who is looking at it. This lesson shows you what it checks and why, so the
errors start to make sense.

The example app for the region is **ClipDesk**, a small desktop media tool (import clips, trim
them, export them). Here it is only a source of `Clip`s, playlists and titles. The Tauri parts come
in **Tauri 2: a desktop app with a web frontend**.

:::info title="Words you'll meet in this lesson"
- **Stack / heap**: the stack holds fixed-size local values and is freed automatically when a
  function returns. The heap holds data whose size is only known at runtime (a `String`'s
  characters, a `Vec`'s items) and must be freed by someone.
- **Owner**: the one variable responsible for freeing a value. Rust calls freeing **drop**.
- **Move**: handing ownership to another variable or function. The old name can't be used anymore.
- **Borrow / reference**: a pointer that lets you use a value without owning it. `&T` is a
  shared (read-only) borrow; `&mut T` is a mutable (exclusive) borrow.
- **Borrow checker**: the compiler pass that proves no reference outlives its value and no value
  is changed while someone else is reading it.
- **Lifetime**: the stretch of code where a reference is valid. Written `'a` when you must name it.
:::

## Why ownership exists

Every program that uses the heap has to answer one question: **who frees this memory, and when?**
There have been three main answers:

| Approach | Languages | Cost |
|---|---|---|
| **Garbage collector** frees what nobody can reach anymore | TypeScript/JS, C#, Java, Go | A runtime that pauses or slows the program sometimes; memory is freed *eventually*, not at a known point. |
| **The programmer** calls `free` / `delete` | C, C++ | Forget it and you leak. Do it twice and you get a *double free*. Use the pointer afterwards and you have a *use-after-free*. Both are classic security bugs. |
| **Ownership**: the compiler knows the single owner and inserts the free when the owner goes out of scope | Rust | Rules you have to follow at compile time. No runtime cost and no GC. |

In TypeScript you never think about this, because the GC deals with it. The price shows up
somewhere else: two parts of a React app can hold the same array and one of them changes it.
In C# two threads can change the same `List<T>` and corrupt it. Rust's rules prevent the memory
bugs **and** these "someone changed it under me" bugs. The same rule (many readers *or* one
writer) covers both, which is why it is worth learning properly.

:::job title="What you'll meet at work"
On a Rust team nobody expects you to "beat" the borrow checker. They expect you to **read its
errors**. rustc errors have a code (`E0382`), point at the exact lines, and often suggest a fix.
`rustc --explain E0382` prints a full explanation with examples. Pasting the code into a review
comment ("this is the E0502 from iterating while pushing") is normal team talk.
:::

## The three ownership rules

From the Rust Book, chapter 4:

1. Each value in Rust has an **owner**.
2. There can only be **one owner at a time**.
3. When the owner goes **out of scope**, the value is **dropped** (freed).

```rust
fn main() {
    {
        let title = String::from("intro.mp4"); // title owns a heap buffer
        println!("{title}");
    } // <- scope ends: Rust calls drop(title) here and the buffer is freed
    // title doesn't exist here
}
```

Rule 3 works like C#'s `using` block or a `finally`, except it applies to every value and you
don't write anything. Files close, locks unlock and sockets disconnect the same way. Rust calls
this **RAII**, from C++.

## Move, Copy, Clone

A `String` is three numbers on the stack (pointer, length, capacity) plus the characters on the
heap. Look at what `let b = a;` does:

```text
let a = String::from("intro");          let b = a;   // MOVE

 stack            heap                   stack            heap
 a: ptr ──────► "intro"                  a: (moved, unusable)
    len 5                                b: ptr ──────► "intro"
    cap 5                                   len 5
                                            cap 5
```

Only the three stack numbers are copied. If `a` stayed usable, two variables would own the same
buffer, and at the end of the scope Rust would free it **twice**. So Rust treats `a` as **moved**:
using it afterwards is a compile error.

```rust
let a = String::from("intro");
let b = a;              // ownership moves to b
println!("{a}");        // error[E0382]: borrow of moved value: `a`
```

Small types that live entirely on the stack (`i32`, `u64`, `f64`, `bool`, `char`, shared
references `&T`, and tuples or arrays made only of these) implement the **`Copy`** trait.
Assigning them copies the bits and the old variable is still valid. Nothing on the heap means
nothing can be freed twice.

When you really want a second independent heap copy, ask for it with **`.clone()`**:

```rust
let a = String::from("intro");
let b = a.clone();      // new heap buffer, "intro" copied into it
println!("{a} {b}");    // fine: two owners of two different buffers
```

| | What happens | Cost | Old variable |
|---|---|---|---|
| **Move** (default for `String`, `Vec`, `Box`, most structs) | Stack bits copied, ownership transferred | Very cheap | Unusable |
| **Copy** (`i32`, `bool`, `char`, `&T`, …) | Bits copied | Very cheap | Still usable |
| **Clone** (explicit `.clone()`) | Deep copy, often a heap allocation | Can be expensive | Still usable |

Your own struct can be `Copy` only if **all** its fields are `Copy`: `#[derive(Clone, Copy)]` on a
struct with a `String` field fails with `E0204`.

:::quiz id=rs-02-q1 xp=10
Will this compile?

```rust
fn main() {
    let path = String::from("clips/intro.mp4");
    let saved = path;
    println!("Saved {saved}, original {path}");
}
```

- [ ] Yes: `path` and `saved` both point to the same string, like in TypeScript.
- [x] No: `error[E0382]`, `path` was moved into `saved`.
- [ ] No: `error[E0499]`, two mutable borrows.
- [ ] Yes, but it prints the path twice.
> `String` is not `Copy`, so `let saved = path;` moves ownership. Using `path` afterwards is
> E0382 ("borrow of moved value"; `println!` borrows its arguments). Fixes: print `saved` only,
> borrow with `let saved = &path;`, or use `path.clone()` if you really need two strings.
:::

:::quiz id=rs-02-q2 xp=10
Will this compile?

```rust
fn main() {
    let secs: u32 = 95;
    let backup = secs;
    println!("{secs} {backup}");
}
```

- [x] Yes: `u32` is `Copy`, so `backup` is an independent copy.
- [ ] No: E0382, `secs` was moved.
- [ ] No: you need `secs.clone()`.
- [ ] Only if `secs` is declared `mut`.
> Integer types implement `Copy`. Assignment copies the bits and both variables stay valid. The
> move rule only bites for types that own resources (heap memory, file handles…).
:::

:::quiz id=rs-02-q3 xp=10
Which of these types are `Copy`? (select all that apply)

- [x] `i64`
- [x] `(u32, bool)`
- [x] `&str`
- [ ] `String`
- [ ] `Vec<u8>`
- [ ] `Box<i32>`
> Integers, bools, chars, floats, shared references and tuples or arrays of `Copy` types are
> `Copy`. `String`, `Vec` and `Box` own heap memory, so copying their bits would create two owners.
> They move instead, and you `.clone()` them explicitly. `&str` is a shared reference, and
> copying a reference just gives you another reader.
:::

### Functions move too

Passing a value to a function works exactly like assignment. A non-`Copy` argument is **moved
into** the function, and the function's parameter becomes the owner:

```rust
fn upload(title: String) { /* ... title is dropped at the end of this fn */ }

fn main() {
    let t = String::from("intro");
    upload(t);
    upload(t);   // error[E0382]: use of moved value: `t`
}
```

The same happens with `for x in vec`: a `for` loop over a `Vec` **consumes** it. Loop over `&vec`
to borrow it instead.

Returning ownership every time ("give it back when you're done") would be tedious. That is what
borrowing is for.

## Borrowing: many readers XOR one writer

A **reference** lets a function use a value without taking it:

```rust
fn title_len(title: &String) -> usize {   // borrows; does not own
    title.len()
}                                         // nothing is dropped here: we never owned it

fn add_ext(title: &mut String) {          // mutable borrow: may change it
    title.push_str(".mp4");
}

fn main() {
    let mut t = String::from("intro");    // must be `mut` to hand out &mut
    add_ext(&mut t);
    println!("{} has {} bytes", t, title_len(&t));
}
```

The central rule, which the Rust Book calls *the rules of references*:

> At any given time you can have **either** one mutable reference **or** any number of
> immutable references. References must always be **valid**.

```text
            &T  &T  &T              &mut T
             │   │   │                 │
             ▼   ▼   ▼                 ▼
          ┌─────────────┐        ┌─────────────┐
          │    value    │        │    value    │
          └─────────────┘        └─────────────┘
     many readers, nobody         exactly one writer,
     can change it                nobody else may even read
```

If you know databases, think of a read/write lock that the compiler checks at **compile time**:
shared locks or one exclusive lock, never both.

### Why both halves matter

**Readers XOR writer prevents use-after-free.** A `Vec` stores its items in a heap buffer. When
you `push` and the buffer is full, the `Vec` allocates a bigger buffer, moves the items, and
**frees the old one**. A reference into the old buffer would now point at freed memory:

```rust
let mut playlist = vec![String::from("intro"), String::from("outro")];
let first = &playlist[0];          // shared borrow of playlist
playlist.push(String::from("credits")); // needs &mut playlist, may reallocate
println!("{first}");               // first might point at freed memory
// error[E0502]: cannot borrow `playlist` as mutable because it is also borrowed as immutable
```

In C++ this compiles and sometimes crashes. In C# the `foreach`-and-modify version throws
`InvalidOperationException: Collection was modified` at **runtime**. Rust rejects it at compile time.

**One writer prevents data races.** A data race needs three things: two accesses to the same
memory at the same time, at least one of them a write, and no synchronization. The rule says a
writer is always alone, so safe Rust cannot express a data race. The same rule applies across
threads (more in **Concurrency and async: threads, channels, tokio**).

:::quiz id=rs-02-q4 xp=10
Will this compile?

```rust
fn main() {
    let mut queue = vec![String::from("intro.mp4")];
    for clip in &queue {
        if clip.ends_with(".mp4") {
            queue.push(clip.replace(".mp4", ".webm"));
        }
    }
}
```

- [ ] Yes: the loop only reads, and `push` only adds.
- [x] No: `error[E0502]`, `queue` is borrowed immutably by the loop and `push` needs a mutable borrow.
- [ ] No: `error[E0382]`, the loop moved `queue`.
- [ ] It compiles but panics at runtime.
> `for clip in &queue` holds a shared borrow for the whole loop, and `push` needs `&mut queue`.
> This is "modify a collection while iterating it", the same bug C# reports at runtime. The usual
> fix: collect the new items into a separate `Vec` inside the loop, then
> `queue.extend(new_items)` afterwards.
:::

### Borrows end at their last use (NLL)

A borrow does not have to last until the closing `}`. Since Rust 2018 the compiler uses
**non-lexical lifetimes (NLL)**: a reference is alive from where it is created to its **last
use**. That is why this is fine:

```rust
let mut s = String::from("clip");
let r1 = &s;
let r2 = &s;
println!("{r1} {r2}");   // last use of r1 and r2: their borrows end here
let r3 = &mut s;         // OK: no shared borrow is alive anymore
r3.push_str("-v2");
```

:::quiz id=rs-02-q5 xp=10
Will the snippet above (two shared borrows, a `println!`, then `&mut s`) compile?

- [x] Yes: the shared borrows end at their last use, before `&mut s` is created.
- [ ] No: E0502, `r1` and `r2` are still in scope until the end of `main`.
- [ ] No: E0499, `r3` is a second mutable borrow.
- [ ] Only in edition 2015.
> With non-lexical lifetimes a borrow lives until its last *use*, not until the end of the block.
> Move the `println!` below `r3.push_str` and you get E0502, because then `r1` and `r2` are
> still alive while `r3` exists.
:::

:::quiz id=rs-02-q6 xp=10
Will this compile? If not, which error?

```rust
fn main() {
    let mut title = String::from("intro");
    let a = &mut title;
    let b = &mut title;
    a.push('!');
    b.push('?');
}
```

- [ ] Compiles: both are writers, but they change different ends of the string.
- [ ] `error[E0502]`: mutable borrow while immutable borrow.
- [x] `error[E0499]`: cannot borrow `title` as mutable more than once at a time.
- [ ] `error[E0596]`: `title` isn't `mut`.
> Two `&mut` to the same value alive at the same time is E0499. `a` is still used after `b` is
> created, so the two overlap. Use them one after the other (finish with `a` before creating `b`),
> or restructure. To get two `&mut` into *different elements* of a slice, use
> `split_at_mut`, which you'll do in the lab.
:::

:::warn title="mut on the variable vs &mut"
`let mut x` means "this binding may change". `&mut x` borrows it for writing, and only works if
`x` was declared `mut`. Otherwise you get `E0596: cannot borrow as mutable`. Assigning twice to a
non-`mut` binding is `E0384`. Both are one-word fixes, and rustc suggests them.
:::

## Slices: borrowing part of something

A **slice** is a reference to a contiguous part of a collection: a pointer plus a length.

- `&str` is a string slice: a view into UTF-8 bytes owned by a `String`, or baked into the
  binary for literals (`"intro"` has type `&'static str`).
- `&[T]` is a slice of items: a view into a `Vec<T>`, an array, or part of either.

```rust
let file = String::from("intro.mp4");
let stem: &str = &file[0..5];          // "intro": borrows bytes 0..5 of file
let clips = vec![20, 65, 10];
let tail: &[u32] = &clips[1..];        // [65, 10]
```

Because a slice is a borrow, the rules apply: you can't `clear()` the `String` while `stem` is
alive (E0502), and you can't drop it either (E0505, "cannot move out of `file` because it is
borrowed").

:::pro title="Take &str and &[T], return owned types"
Write parameters as `&str` instead of `&String`, and `&[T]` instead of `&Vec<T>`. A `&String`
coerces to `&str` automatically, so callers can pass a `String`, a literal or a slice of either.
Clippy (`cargo clippy`) warns about `&Vec<T>` parameters (`ptr_arg`). For return values, return
owned `String`/`Vec` unless the result really is a view into an input.
:::

:::warn title="String slices index bytes, not characters"
`&s[0..2]` on `"héllo"` **panics** at runtime: `é` is two bytes in UTF-8 and index 2 falls in the
middle of it ("end byte index 2 is not a char boundary"). Use `s.chars()`, `s.char_indices()` or
`s.get(0..2)` (returns `Option`) when the text isn't plain ASCII. A media app will meet
non-ASCII file names on day one.
:::

## Practice: a borrow checker in TypeScript

The browser can't run rustc, but it can run a model of the rules. Building one is the best way
to make "readers XOR writer" and "use after move" automatic.

:::challenge id=rs-02-c1 lang=ts xp=60
title: A tiny borrow checker
Write `check(events)`. It walks a list of events in order and returns the **first** error as
`{ step, code }` (`step` = index in the array), or `null` if the program is fine.

Events (`name`/`of`/`from` are owner variables; `ref` names a reference):

| Event | Rust it models |
|---|---|
| `{ op: 'let', name, mut?, copy? }` | `let [mut] name = …` (declares or **shadows** a fresh owner; `copy: true` = a `Copy` type like `u32`) |
| `{ op: 'borrow', of, ref }` | `let ref = &of;` |
| `{ op: 'borrowMut', of, ref }` | `let ref = &mut of;` |
| `{ op: 'release', ref }` | last use of `ref` (NLL: the borrow ends). Unknown refs are ignored. |
| `{ op: 'use', name }` | read `name` (e.g. `println!("{name}")`, which is a shared borrow) |
| `{ op: 'move', from, to }` | `let to = from;` (`to` becomes a new non-`mut` owner with the same `copy` flag) |

Rules, checked in this order for every event except `let`/`release`:

1. The owner doesn't exist → `E0425`. It was moved → `E0382`.
2. `use`: a mutable borrow of it is alive → `E0502`.
3. `borrow`: a mutable borrow is alive → `E0502`.
4. `borrowMut`: owner not `mut` → `E0596`; another mutable borrow alive → `E0499`; any shared
   borrow alive → `E0502`.
5. `move` of a `copy` owner: a mutable borrow alive → `E0503`; otherwise it's a copy (the source
   stays usable).
6. `move` of a non-`copy` owner: any borrow alive → `E0505`; otherwise the source becomes moved.

hint: Keep two maps: owners (`mut`, `copy`, `moved`) and live refs (`ref` → `{ of, mut }`).
hint: "Borrows of x" = the live refs whose `of` is `x`. Check `.some(r => r.mut)` and `.length`.
hint: `let` replaces the owner entry entirely, so a shadowed name is usable again even if the old one was moved.

```ts starter
export type Event =
  | { op: 'let'; name: string; mut?: boolean; copy?: boolean }
  | { op: 'borrow'; of: string; ref: string }
  | { op: 'borrowMut'; of: string; ref: string }
  | { op: 'release'; ref: string }
  | { op: 'use'; name: string }
  | { op: 'move'; from: string; to: string }

export type BorrowError = { step: number; code: string } | null

export function check(events: Event[]): BorrowError {
  // TODO: track owners and live references, return the first error
  return null
}
```

```ts solution
export type Event =
  | { op: 'let'; name: string; mut?: boolean; copy?: boolean }
  | { op: 'borrow'; of: string; ref: string }
  | { op: 'borrowMut'; of: string; ref: string }
  | { op: 'release'; ref: string }
  | { op: 'use'; name: string }
  | { op: 'move'; from: string; to: string }

export type BorrowError = { step: number; code: string } | null

type Owner = { mut: boolean; copy: boolean; moved: boolean }

export function check(events: Event[]): BorrowError {
  const owners = new Map<string, Owner>()
  const refs = new Map<string, { of: string; mut: boolean }>()

  for (let step = 0; step < events.length; step++) {
    const e = events[step]
    if (e.op === 'let') {
      owners.set(e.name, { mut: !!e.mut, copy: !!e.copy, moved: false })
      continue
    }
    if (e.op === 'release') {
      refs.delete(e.ref)
      continue
    }
    const name = e.op === 'use' ? e.name : e.op === 'move' ? e.from : e.of
    const owner = owners.get(name)
    if (!owner) return { step, code: 'E0425' }
    if (owner.moved) return { step, code: 'E0382' }
    const borrows = [...refs.values()].filter((r) => r.of === name)
    const mutAlive = borrows.some((r) => r.mut)

    if (e.op === 'use') {
      if (mutAlive) return { step, code: 'E0502' }
    } else if (e.op === 'borrow') {
      if (mutAlive) return { step, code: 'E0502' }
      refs.set(e.ref, { of: name, mut: false })
    } else if (e.op === 'borrowMut') {
      if (!owner.mut) return { step, code: 'E0596' }
      if (mutAlive) return { step, code: 'E0499' }
      if (borrows.length > 0) return { step, code: 'E0502' }
      refs.set(e.ref, { of: name, mut: true })
    } else {
      if (owner.copy) {
        if (mutAlive) return { step, code: 'E0503' }
      } else {
        if (borrows.length > 0) return { step, code: 'E0505' }
        owner.moved = true
      }
      owners.set(e.to, { mut: false, copy: owner.copy, moved: false })
    }
  }
  return null
}
```

```ts tests
test('a clean program has no error', () => {
  expect(check([
    { op: 'let', name: 's', mut: true },
    { op: 'borrow', of: 's', ref: 'r1' },
    { op: 'borrow', of: 's', ref: 'r2' },
    { op: 'use', name: 's' },
    { op: 'release', ref: 'r1' },
    { op: 'release', ref: 'r2' },
    { op: 'borrowMut', of: 's', ref: 'w' },
    { op: 'release', ref: 'w' },
    { op: 'move', from: 's', to: 't' },
    { op: 'use', name: 't' },
  ])).toBeNull()
})

test('use after move is E0382', () => {
  expect(check([
    { op: 'let', name: 'path' },
    { op: 'move', from: 'path', to: 'saved' },
    { op: 'use', name: 'saved' },
    { op: 'use', name: 'path' },
  ])).toEqual({ step: 3, code: 'E0382' })
})

test('Copy types are copied, not moved', () => {
  expect(check([
    { op: 'let', name: 'secs', copy: true },
    { op: 'move', from: 'secs', to: 'backup' },
    { op: 'use', name: 'secs' },
    { op: 'move', from: 'backup', to: 'again' },
    { op: 'use', name: 'backup' },
  ])).toBeNull()
})

test('two live mutable borrows is E0499', () => {
  expect(check([
    { op: 'let', name: 'title', mut: true },
    { op: 'borrowMut', of: 'title', ref: 'a' },
    { op: 'borrowMut', of: 'title', ref: 'b' },
  ])).toEqual({ step: 2, code: 'E0499' })
})

test('shared and mutable together is E0502, in both orders', () => {
  expect(check([
    { op: 'let', name: 'queue', mut: true },
    { op: 'borrow', of: 'queue', ref: 'first' },
    { op: 'borrowMut', of: 'queue', ref: 'push' },
  ])).toEqual({ step: 2, code: 'E0502' })
  expect(check([
    { op: 'let', name: 'queue', mut: true },
    { op: 'borrowMut', of: 'queue', ref: 'w' },
    { op: 'borrow', of: 'queue', ref: 'r' },
  ])).toEqual({ step: 2, code: 'E0502' })
})

test('reading an owner while it is mutably borrowed is E0502', () => {
  expect(check([
    { op: 'let', name: 's', mut: true },
    { op: 'borrowMut', of: 's', ref: 'w' },
    { op: 'use', name: 's' },
  ])).toEqual({ step: 2, code: 'E0502' })
})

test('released borrows no longer conflict (NLL)', () => {
  expect(check([
    { op: 'let', name: 's', mut: true },
    { op: 'borrowMut', of: 's', ref: 'a' },
    { op: 'release', ref: 'a' },
    { op: 'borrowMut', of: 's', ref: 'b' },
    { op: 'release', ref: 'b' },
    { op: 'use', name: 's' },
  ])).toBeNull()
})

test('&mut of a non-mut binding is E0596', () => {
  expect(check([
    { op: 'let', name: 'log' },
    { op: 'borrowMut', of: 'log', ref: 'w' },
  ])).toEqual({ step: 1, code: 'E0596' })
})

test('moving out while borrowed is E0505; copying while &mut is E0503', () => {
  expect(check([
    { op: 'let', name: 'file' },
    { op: 'borrow', of: 'file', ref: 'stem' },
    { op: 'move', from: 'file', to: 'other' },
  ])).toEqual({ step: 2, code: 'E0505' })
  expect(check([
    { op: 'let', name: 'n', mut: true, copy: true },
    { op: 'borrow', of: 'n', ref: 'r' },
    { op: 'move', from: 'n', to: 'm' },
    { op: 'release', ref: 'r' },
    { op: 'borrowMut', of: 'n', ref: 'w' },
    { op: 'move', from: 'n', to: 'k' },
  ])).toEqual({ step: 5, code: 'E0503' })
})

test('unknown names are E0425; borrows are of the owner, not other owners', () => {
  expect(check([{ op: 'use', name: 'clip' }])).toEqual({ step: 0, code: 'E0425' })
  expect(check([
    { op: 'let', name: 'a', mut: true },
    { op: 'let', name: 'b', mut: true },
    { op: 'borrowMut', of: 'a', ref: 'wa' },
    { op: 'borrowMut', of: 'b', ref: 'wb' },
    { op: 'use', name: 'a' },
  ])).toEqual({ step: 4, code: 'E0502' })
})

test('shadowing with let makes a moved name usable again', () => {
  expect(check([
    { op: 'let', name: 's' },
    { op: 'move', from: 's', to: 't' },
    { op: 'let', name: 's' },
    { op: 'use', name: 's' },
    { op: 'move', from: 't', to: 'u' },
    { op: 'move', from: 't', to: 'v' },
  ])).toEqual({ step: 5, code: 'E0382' })
})
```
:::

The real borrow checker is smarter than this model. It tracks borrows of individual struct
fields, follows control flow through `if` and loops, and works out "last use" by itself. The
rules it enforces are the same ones you just coded.

## References must be valid: dangling references

The second half of the rule ("references must always be valid") stops you from handing out a
pointer to something that is about to be dropped:

```rust
fn newest_title() -> &String {        // error[E0106]: missing lifetime specifier
    let t = String::from("intro");
    &t                                // t is dropped when the function returns
}
```

There is nothing the returned reference could point to, because `t` dies at the `}`. Return the
**owned** value instead: `fn newest_title() -> String { String::from("intro") }`. Ownership moves
to the caller and nothing dangles. (If you try to silence E0106 by writing `-> &'static String`,
the compiler moves on to `E0515: cannot return reference to local variable`. The problem is the
design, not the annotation.)

:::quiz id=rs-02-q7 xp=10
Will this compile?

```rust
fn main() {
    let r;
    {
        let secs = 95;
        r = &secs;
    }
    println!("{r}");
}
```

- [ ] Yes: `secs` is `Copy`, so `r` gets a copy.
- [x] No: `error[E0597]`, `secs` does not live long enough.
- [ ] No: E0106, missing lifetime specifier.
- [ ] Yes, but it prints garbage.
> `r` is a *reference* to `secs`, not a copy (that would be `r = secs`). `secs` is dropped at the
> inner `}` while `r` is used afterwards, so the reference would dangle: E0597. `Copy` only
> matters when you copy the value, not when you borrow it.
:::

## Lifetimes: naming how long a borrow lives

Every reference has a **lifetime**, the region of code where it's valid. Most of the time the
compiler works it out and you never write one. You must write one when a function **returns a
reference** and the compiler can't tell **which input it borrows from**:

```rust
fn longest(x: &str, y: &str) -> &str {      // error[E0106]: missing lifetime specifier
    if x.len() > y.len() { x } else { y }
}
```

The caller needs to know how long the result stays valid. That depends on whether it came from
`x` or `y`, and the signature doesn't say. You say it with a **lifetime parameter**:

```rust
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
```

Read `<'a>` as a generic parameter, like `<T>`, but for "how long". The signature promises: *the
result lives at least as long as the shorter of `x` and `y`*. Annotations **don't change how long
anything lives**. They describe the relationship so the compiler can check every caller:

```rust
let a = String::from("interview");
let result;
{
    let b = String::from("intro");
    result = longest(a.as_str(), b.as_str());
}                       // b dropped here
println!("{result}");   // error[E0597]: `b` does not live long enough
```

Even though `a` is longer at runtime, the compiler only goes by the signature: `result` may come
from `b`, so it can't outlive `b`.

```text
 'a for a: ├──────────────────────────────────────────────┤
 'a for b:          ├──────────────┤
 result is used here:                          ▲  ← outside b's lifetime → E0597
 'a = the overlap:  ├──────────────┤
```

:::quiz id=rs-02-q8 xp=10
In `fn longest<'a>(x: &'a str, y: &'a str) -> &'a str`, what does `'a` do?

- [ ] It makes `x` and `y` live longer, until the result is dropped.
- [ ] It tells the runtime to keep both strings in memory.
- [x] It tells the compiler the result borrows from `x` or `y`, so callers may use it only while both are alive.
- [ ] Nothing: it's documentation, ignored by the compiler.
> Lifetime annotations are constraints for the borrow checker, not instructions. Nothing is kept
> alive longer and there's no runtime cost. The compiler checks each call site against the
> promise in the signature.
:::

### Lifetime elision: why you rarely write `'a`

The compiler fills in lifetimes for you with three **elision rules** (Rust Reference, "Lifetime
elision"):

1. Each reference parameter gets its own lifetime: `fn f(a: &str, b: &str)` becomes
   `fn f<'a, 'b>(a: &'a str, b: &'b str)`.
2. If there is **exactly one** input lifetime, it is given to every output reference:
   `fn stem(file: &str) -> &str` just works.
3. If there are several inputs but one of them is `&self` or `&mut self`, the output gets
   **self's** lifetime. That covers getters like `fn title(&self) -> &str`.

If the rules don't settle it (two reference inputs, no `self`, a reference output), you get
E0106 and you write the annotation yourself.

:::quiz id=rs-02-q9 xp=10
Which signatures compile **without** writing any lifetime? (select all that apply)

- [x] `fn stem(file: &str) -> &str`
- [x] `fn tail(clips: &[u32]) -> &[u32]`
- [x] `fn title(&self) -> &str` (in an `impl Clip` block)
- [ ] `fn pick(a: &str, b: &str) -> &str`
- [x] `fn count(a: &str, b: &str) -> usize`
> One reference input means rule 2 applies. `&self` means rule 3. `count` returns no reference,
> so no output lifetime is needed. `pick` has two reference inputs and no `self`, so the compiler
> can't choose and reports E0106. Write `fn pick<'a>(a: &'a str, b: &'a str) -> &'a str`.
:::

### Structs that hold references, and `'static`

A struct that stores a reference must declare the lifetime, because the struct can't outlive
what it points to:

```rust
struct TitleView<'a> {
    title: &'a str,          // without <'a>: error[E0106]: missing lifetime specifier
}
```

`'static` means "valid for the whole program". String literals are `&'static str` because they are
stored in the binary. When a compiler error says something "must be `'static`" (very common with
threads and async tasks), it almost never wants you to add `'static` to a reference. It wants an
**owned** value (`String` instead of `&str`) or an `Arc`.

:::pro title="Rule of thumb for app code"
In application code (a Tauri backend, a CLI) most structs should **own** their data: `String`,
`Vec<T>`, `PathBuf`. Borrowing structs with lifetimes are for short-lived views and for parsers
that must not copy. If adding lifetimes to a struct spreads `<'a>` through half the codebase, the
struct probably should own the data, or the data should go behind an `Arc`.
:::

## Smart pointers: Box, Rc, RefCell, Arc

Sometimes "one owner, borrows checked at compile time" doesn't fit the problem. The standard
library has a few types that bend the rules in controlled ways.

**`Box<T>`: one owner, value on the heap.** Use it for recursive types (a type can't contain
itself directly because its size would be infinite: `E0072`), for large values you want to move
cheaply, and for trait objects (`Box<dyn Error>`, covered in **Traits, generics, errors and
crates**).

```rust
enum Track {
    Clip(u32, Box<Track>),   // without Box: error[E0072]: recursive type `Track` has infinite size
    End,
}
```

**`Rc<T>`: several owners, one thread.** `Rc::clone(&rc)` doesn't copy the value. It increases a
reference count, and the value is dropped when the last `Rc` goes away. An `Rc` only gives
**shared** (`&T`) access, so you can't push into an `Rc<Vec<_>>` (E0596, "cannot borrow data in an
`Rc` as mutable").

**`RefCell<T>`: borrow rules checked at runtime.** `cell.borrow()` returns a read guard and
`cell.borrow_mut()` returns a write guard. The guards follow the same readers-XOR-writer rule, but
it's checked **while the program runs**: break it and the program **panics** with
`RefCell already borrowed` / `RefCell already mutably borrowed`. Together they make the usual
single-threaded "shared and mutable" combination: `Rc<RefCell<T>>`.

**`Arc<T>`: `Rc` for threads.** The count is updated with atomic CPU instructions, so `Arc` can be
sent to other threads. Its mutable companion is `Mutex<T>` (or `RwLock<T>`): `Arc<Mutex<T>>`. The
compiler won't let you send an `Rc` to another thread: `E0277: Rc<i32> cannot be sent between
threads safely`. The `Send`/`Sync` traits behind that check are in **Concurrency and async:
threads, channels, tokio**.

| Need | Single thread | Across threads |
|---|---|---|
| One owner on the heap | `Box<T>` | `Box<T>` |
| Shared, read-only | `Rc<T>` | `Arc<T>` |
| Shared and mutable | `Rc<RefCell<T>>` | `Arc<Mutex<T>>` / `Arc<RwLock<T>>` |
| Borrow check | compile time (`RefCell`: runtime) | runtime (`Mutex` blocks instead of panicking) |

:::info title="Preview: shared state in Tauri 2"
In a Tauri 2 app you register state once with `app.manage(Mutex::new(AppState::default()))` and
commands receive it as `state: State<'_, Mutex<AppState>>`. Note the elided lifetime `'_`. Tauri
already shares managed state for you, so the docs say you **don't** need to wrap it in `Arc`
yourself. Details in **Tauri 2: a desktop app with a web frontend**.
:::

:::quiz id=rs-02-q10 xp=10
What happens here?

```rust
use std::cell::RefCell;

fn main() {
    let log = RefCell::new(vec![String::from("import")]);
    let reader = log.borrow();
    log.borrow_mut().push(String::from("export"));
    println!("{:?}", reader);
}
```

- [ ] Compile error E0502.
- [x] It compiles, then panics at runtime: `RefCell already borrowed`.
- [ ] It prints `["import", "export"]`.
- [ ] It prints `["import"]`, because `reader` is a snapshot.
> `RefCell` moves the borrow check to runtime, so the compiler accepts it. When `borrow_mut()`
> runs, the read guard `reader` is still alive, and the cell panics. Fix: end the read borrow
> first (use `reader` and let it drop, or call `drop(reader)`) before borrowing mutably.
:::

:::quiz id=rs-02-q11 xp=10
You move an `Rc<Settings>` into `std::thread::spawn(move || …)`. What does rustc say?

- [ ] Nothing: `move` closures can take anything.
- [ ] E0382: the `Rc` was moved.
- [x] E0277: `Rc<Settings>` cannot be sent between threads safely. Use `Arc<Settings>`.
- [ ] E0499: two threads borrow it mutably.
> `Rc`'s counter isn't atomic, so two threads cloning it at once could corrupt the count. `Rc`
> doesn't implement `Send`, and `thread::spawn` requires its closure to be `Send`. `Arc` uses an
> atomic counter and is `Send` (when `T` is `Send + Sync`).
:::

:::challenge id=rs-02-c2 lang=ts xp=40
title: RefCell's runtime borrow flag
Model `RefCell<T>`. It keeps a single counter: `0` = free, `n > 0` = n readers, `-1` = one writer.

- `borrow()` returns a guard `{ value, release() }`. If a writer is active it **throws**
  `Error('RefCell already mutably borrowed')`.
- `borrowMut()` returns a guard `{ value, set(v), release() }`. If **anyone** holds a borrow it
  throws `Error('RefCell already borrowed')`.
- `release()` undoes that guard's borrow. Calling it a second time does nothing, just as a Rust
  guard can only be dropped once.
- `state()` returns the counter.

hint: Store `flag: number`. Reader: `flag += 1` / `flag -= 1`. Writer: `flag = -1` / `flag = 0`.
hint: Give each guard its own `released` boolean so a second `release()` is a no-op.

```ts starter
export class RefCellModel<T> {
  private value: T
  private flag = 0

  constructor(value: T) {
    this.value = value
  }

  state(): number {
    return this.flag
  }

  borrow(): { value: T; release: () => void } {
    // TODO: refuse while a writer is active, count readers
    return { value: this.value, release: () => {} }
  }

  borrowMut(): { value: T; set: (v: T) => void; release: () => void } {
    // TODO: refuse while anyone borrows, mark the writer
    return { value: this.value, set: (v: T) => { this.value = v }, release: () => {} }
  }
}
```

```ts solution
export class RefCellModel<T> {
  private value: T
  private flag = 0

  constructor(value: T) {
    this.value = value
  }

  state(): number {
    return this.flag
  }

  borrow(): { value: T; release: () => void } {
    if (this.flag < 0) throw new Error('RefCell already mutably borrowed')
    this.flag += 1
    let released = false
    return {
      value: this.value,
      release: () => {
        if (released) return
        released = true
        this.flag -= 1
      },
    }
  }

  borrowMut(): { value: T; set: (v: T) => void; release: () => void } {
    if (this.flag !== 0) throw new Error('RefCell already borrowed')
    this.flag = -1
    let released = false
    return {
      value: this.value,
      set: (v: T) => {
        this.value = v
      },
      release: () => {
        if (released) return
        released = true
        this.flag = 0
      },
    }
  }
}
```

```ts tests
test('many readers at once', () => {
  const cell = new RefCellModel(['import'])
  const a = cell.borrow()
  const b = cell.borrow()
  expect(cell.state()).toBe(2)
  expect(a.value).toEqual(['import'])
  a.release()
  b.release()
  expect(cell.state()).toBe(0)
})

test('a writer while reading throws "already borrowed"', () => {
  const cell = new RefCellModel(1)
  const r = cell.borrow()
  expect(() => cell.borrowMut()).toThrow('RefCell already borrowed')
  r.release()
  const w = cell.borrowMut()
  expect(cell.state()).toBe(-1)
  w.set(2)
  w.release()
  expect(cell.borrow().value).toBe(2)
})

test('reading while writing throws "already mutably borrowed"', () => {
  const cell = new RefCellModel('x')
  const w = cell.borrowMut()
  expect(() => cell.borrow()).toThrow('RefCell already mutably borrowed')
  expect(() => cell.borrowMut()).toThrow('RefCell already borrowed')
  w.release()
  expect(cell.state()).toBe(0)
})

test('releasing twice is a no-op', () => {
  const cell = new RefCellModel(0)
  const a = cell.borrow()
  const b = cell.borrow()
  a.release()
  a.release()
  expect(cell.state()).toBe(1)
  expect(() => cell.borrowMut()).toThrow('RefCell already borrowed')
  b.release()
  const w = cell.borrowMut()
  w.release()
  w.release()
  expect(cell.state()).toBe(0)
})
```
:::

## Lab: make the ClipDesk drills compile

:::lab id=rs-02-lab1 xp=100
title: Fix eight non-compiling functions
You get a small library with **nine compile errors** in eight functions, each a classic borrow-checker
mistake. The integration tests describe the intended behaviour. Fix the library until
`cargo test` passes, and **do not change the tests**. Works on Linux, macOS and Windows with
**Rust stable** (1.85 or newer, for edition 2024; checked with rustc 1.97).

**1. Create the project**

```bash
rustup update stable
cargo new --lib clipdesk-borrow
cd clipdesk-borrow
mkdir tests
```

`Cargo.toml` should say `edition = "2024"` (the default for `cargo new` since Rust 1.85).

**2. The broken library**: replace `src/lib.rs` with this

```rust
//! ClipDesk borrow-checker drills. Every function below fails to compile.
//! Fix them one at a time, without changing any test.

use std::cell::RefCell;
use std::rc::Rc;

#[derive(Debug, Clone, PartialEq)]
pub struct Clip {
    pub title: String,
    pub secs: u32,
}

impl Clip {
    pub fn new(title: &str, secs: u32) -> Clip {
        Clip { title: title.to_string(), secs }
    }
}

// 1. Return the longer of two titles (the first one on a tie).
pub fn longer_title(a: &str, b: &str) -> &str {
    if b.len() > a.len() { b } else { a }
}

// 2. A view that borrows a clip's title instead of copying it.
pub struct TitleView {
    pub title: &str,
}

pub fn view_of(clip: &Clip) -> TitleView {
    TitleView { title: &clip.title }
}

// 3. "3 clips, 95s" — the caller keeps its clips.
fn total_secs(clips: Vec<Clip>) -> u32 {
    clips.iter().map(|c| c.secs).sum()
}

pub fn summary(clips: Vec<Clip>) -> String {
    let total = total_secs(clips);
    format!("{} clips, {total}s", clips.len())
}

// 4. The title of the first clip in the library.
pub struct Library {
    pub clips: Vec<Clip>,
}

impl Library {
    pub fn first_title(&self) -> String {
        self.clips[0].title
    }
}

// 5. Move the longest clip to the front of the queue (keep the others in order).
pub fn promote_longest(queue: &mut Vec<Clip>) {
    let longest = queue.iter().max_by_key(|c| c.secs).unwrap();
    queue.retain(|c| c != longest);
    queue.insert(0, longest.clone());
}

// 6. Swap the titles of two clips (durations stay where they are).
pub fn swap_titles(clips: &mut [Clip], i: usize, j: usize) {
    let a = &mut clips[i];
    let b = &mut clips[j];
    std::mem::swap(&mut a.title, &mut b.title);
}

// 7. Two parts of the app append to one shared activity log.
pub fn shared_log() -> Vec<String> {
    let log = Rc::new(Vec::new());
    let importer = Rc::clone(&log);
    let exporter = Rc::clone(&log);
    importer.push(String::from("import intro.mp4"));
    exporter.push(String::from("export intro.webm"));
    drop(importer);
    drop(exporter);
    Rc::try_unwrap(log).unwrap()
}

// 8. Count clips longer than a minute.
pub fn count_long(clips: &[Clip]) -> usize {
    let count = 0;
    for c in clips {
        if c.secs > 60 {
            count += 1;
        }
    }
    count
}
```

**3. The tests**: create `tests/drills.rs` (integration tests use the crate by its name, with
`-` turned into `_`)

```rust
use clipdesk_borrow::*;

fn sample() -> Vec<Clip> {
    vec![
        Clip::new("intro", 20),
        Clip::new("interview", 65),
        Clip::new("outro", 10),
    ]
}

#[test]
fn longer_title_picks_the_longer_one_and_the_first_on_a_tie() {
    assert_eq!(longer_title("intro", "interview"), "interview");
    assert_eq!(longer_title("abc", "xyz"), "abc");
}

#[test]
fn title_view_borrows_from_the_clip() {
    let clip = Clip::new("teaser", 5);
    let view = view_of(&clip);
    assert_eq!(view.title, "teaser");
    // Same address: the view points into the clip, nothing was copied.
    assert_eq!(view.title.as_ptr(), clip.title.as_ptr());
}

#[test]
fn summary_counts_and_sums() {
    let clips = sample();
    assert_eq!(summary(&clips), "3 clips, 95s");
    assert_eq!(clips.len(), 3); // the caller still owns its clips
}

#[test]
fn first_title_leaves_the_library_intact() {
    let lib = Library { clips: sample() };
    assert_eq!(lib.first_title(), "intro");
    assert_eq!(lib.clips[0].title, "intro");
}

#[test]
fn promote_longest_moves_it_to_the_front() {
    let mut q = sample();
    promote_longest(&mut q);
    let titles: Vec<&str> = q.iter().map(|c| c.title.as_str()).collect();
    assert_eq!(titles, ["interview", "intro", "outro"]);
}

#[test]
fn swap_titles_keeps_durations() {
    let mut clips = sample();
    swap_titles(&mut clips, 0, 2);
    assert_eq!(clips[0], Clip::new("outro", 20));
    assert_eq!(clips[2], Clip::new("intro", 10));
    swap_titles(&mut clips, 1, 1); // same index: nothing changes, no panic
    assert_eq!(clips[1], Clip::new("interview", 65));
}

#[test]
fn shared_log_sees_both_writers() {
    assert_eq!(shared_log(), ["import intro.mp4", "export intro.webm"]);
}

#[test]
fn count_long_counts_clips_over_a_minute() {
    assert_eq!(count_long(&sample()), 1);
    assert_eq!(count_long(&[]), 0);
}
```

**4. Read the errors**

```bash
cargo build
```

You should see these nine errors (plus a warning that `RefCell` is unused, which is a hint):

```text
error[E0106]: missing lifetime specifier          (longer_title)
error[E0106]: missing lifetime specifier          (TitleView)
error[E0382]: borrow of moved value: `clips`      (summary)
error[E0507]: cannot move out of index of `Vec<Clip>`   (first_title)
error[E0502]: cannot borrow `*queue` as mutable because it is also borrowed as immutable   (promote_longest)
error[E0499]: cannot borrow `clips[_]` as mutable more than once at a time   (swap_titles)
error[E0596]: cannot borrow data in an `Rc` as mutable   (shared_log, twice)
error[E0384]: cannot assign twice to immutable variable `count`   (count_long)
error: could not compile `clipdesk-borrow` (lib) due to 9 previous errors; 1 warning emitted
```

Run `rustc --explain E0507` (or any other code) when a message isn't clear.

**5. Fix them.** Rules: tests stay untouched, no `unsafe`, and every function keeps its job.
The tests set the expected signatures, e.g. `summary(&clips)`.

:::tip title="Hints, one per drill (try first, then peek)"
1. Name one lifetime `'a` for both inputs and the output.
2. `pub struct TitleView<'a> { pub title: &'a str }` and return `TitleView<'_>` from `view_of`.
3. Neither function needs ownership: take `&[Clip]` in both.
4. You can't move a `String` out of a borrowed `Vec`. Return `.clone()`, or change the return
   type to `&str`.
5. `longest` borrows `queue` while `retain` needs it mutably. Clone the clip *before* mutating:
   `.unwrap().clone()`, then compare with `*c != longest` and insert the owned clip.
6. Two `&mut clips[..]` overlap as far as the compiler can tell. Return early when `i == j`, then
   `let (lo, hi) = clips.split_at_mut(i.max(j));` gives two non-overlapping `&mut` slices
   (`lo[i.min(j)]` and `hi[0]`). A version built from `std::mem::take`/`std::mem::replace` on
   `clips[i]` and `clips[j]` also compiles, but depending on the order it can lose the title when
   `i == j`. `clips.swap(i, j)` compiles too, but it moves the durations. The tests catch both.
7. `Rc` gives shared access only. Use `Rc<RefCell<Vec<String>>>`, `importer.borrow_mut().push(…)`,
   and at the end `Rc::try_unwrap(log).unwrap().into_inner()`.
8. `let mut count = 0;`
:::

**6. Verify**

```bash
cargo test
cargo clippy --all-targets
```

Expected (order of tests and timings vary):

```text
running 8 tests
test count_long_counts_clips_over_a_minute ... ok
test first_title_leaves_the_library_intact ... ok
test longer_title_picks_the_longer_one_and_the_first_on_a_tie ... ok
test promote_longest_moves_it_to_the_front ... ok
test shared_log_sees_both_writers ... ok
test summary_counts_and_sums ... ok
test swap_titles_keeps_durations ... ok
test title_view_borrows_from_the_clip ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

`cargo clippy` should finish without warnings.

**7. Break it on purpose** (then undo): put the original three-line body of `promote_longest`
back (borrow `longest`, then `retain`, then `insert(0, longest.clone())`) and read how the E0502
message marks the immutable borrow, the mutable borrow and the later use with three labels.
(Just deleting your `.clone()` gives a different error, E0308, because `longest` is then a
`&Clip` and no longer matches `*c` and `insert`.) That three-point picture is how every borrow error reads.

- [ ] `cargo build` on the original file showed the nine errors listed above
- [ ] All eight drills are fixed without changing `tests/drills.rs` and without `unsafe`
- [ ] `cargo test` reports `8 passed; 0 failed`
- [ ] `cargo clippy --all-targets` reports no warnings
- [ ] For each fix you can name the rule it satisfies (move, readers XOR writer, valid references, `mut`)
:::

## How it breaks in practice

- **"Just add `.clone()`" everywhere.** It makes errors go away and the code compiles, but each
  clone of a `Vec<Clip>` or a big `String` is a heap allocation. In a media app that clones a list
  of 10,000 thumbnails per frame, this shows up as stutter. Clone small things freely; for big
  things, borrow or share with `Rc`/`Arc`.
- **`RefCell` panics in production.** It compiles, but a borrow held across a callback (a guard
  stored in a variable and then an event handler that calls `borrow_mut()`) panics at runtime.
  Keep guards short (`cell.borrow_mut().push(x);` in one statement) and never hold one while
  calling unknown code.
- **Holding a lock or borrow across an `.await`.** Async code is the multi-threaded version of
  the previous point. A `std::sync::MutexGuard` held across an `.await` makes the future non-`Send`
  and tokio refuses to spawn it, or it deadlocks. Covered in **Concurrency and async: threads,
  channels, tokio**.
- **Lifetimes spreading through the codebase.** Someone stores `&'a str` in a config struct, and
  now every struct holding it needs `<'a>`, and it can't go into a Tauri managed state or a
  thread (both need `'static`). The fix is usually to own the data (`String`) at the boundary.
- **`Rc` cycles leak.** Two `Rc`s pointing at each other (a parent and child that both hold
  strong references) never reach count 0, so they are never dropped. Use `Weak` for the back
  pointer (`Rc::downgrade`).
- **Slicing strings by byte index.** `&name[..10]` on a file name with `ü` or an emoji panics.
  Users' file names are not ASCII.
- **Fighting the checker with indices everywhere.** Replacing every reference with a `usize` index
  into a `Vec` "works", but you lose the guarantees: an index can point at the wrong item after
  a removal. Sometimes it's the right design (arenas, entity IDs). It shouldn't be a reflex.

:::cards id=rs-02-cards1 xp=15 title="Ownership & borrowing"
Q: The three ownership rules?
A: Every value has one owner; only one owner at a time; the value is dropped when the owner goes out of scope.
Q: Move vs Copy vs Clone?
A: Move transfers ownership (old name unusable). Copy duplicates bits of simple stack types
   (old name still valid). Clone is an explicit, possibly expensive deep copy.
Q: The borrowing rule?
A: Either any number of `&T` or exactly one `&mut T` at a time, and references must always be valid.
Q: E0382?
A: Use (or borrow) of a moved value. Borrow instead, clone, or restructure so the value isn't needed after the move.
Q: E0499 vs E0502?
A: E0499: two live mutable borrows. E0502: a mutable borrow while a shared one is alive (or the reverse).
Q: E0106?
A: Missing lifetime specifier: a returned or stored reference whose source the compiler can't infer.
   Add `<'a>`, or return an owned value.
Q: E0597 / E0505 / E0507?
A: E0597: borrowed value does not live long enough. E0505: move out while borrowed. E0507:
   cannot move out of a borrow/index (clone it or borrow it).
Q: What are non-lexical lifetimes?
A: A borrow lasts until its last use, not until the end of the block.
Q: The three lifetime elision rules?
A: Each input reference gets its own lifetime; one input lifetime → given to all outputs;
   with `&self`/`&mut self` → outputs get self's lifetime.
Q: Box / Rc / RefCell / Arc in one line each?
A: Box: single owner on the heap. Rc: shared ownership, one thread. RefCell: borrow rules at
   runtime (panics). Arc: atomic Rc for threads, usually with Mutex.
Q: Why does safe Rust have no data races?
A: A write needs `&mut`, which is exclusive, and `Send`/`Sync` stop non-thread-safe types from
   crossing threads.
:::

## Recap

- Rust frees memory without a GC by giving every value **one owner** and dropping it when the
  owner's scope ends.
- Assignment and passing to functions **move** non-`Copy` values; simple stack types are
  **`Copy`**; `.clone()` is the explicit, possibly costly deep copy.
- **Borrowing**: many `&T` readers **or** one `&mut T` writer. This prevents use-after-free
  (iterator invalidation, dangling pointers into reallocated buffers) and data races.
- Borrows end at their **last use** (NLL). Slices (`&str`, `&[T]`) are borrows of part of a value;
  prefer them as parameters.
- Learn the error codes: **E0382** (moved), **E0499** (two writers), **E0502** (reader + writer),
  **E0106** (missing lifetime), plus E0597, E0505, E0507, E0596.
- **Lifetimes** describe how long borrows must be valid; they never extend anything. **Elision**
  fills them in for one-input functions and methods on `&self`.
- When single ownership doesn't fit: **`Box`** (heap, one owner), **`Rc`** / **`RefCell`**
  (shared, single thread, runtime checks), **`Arc`** + **`Mutex`** (shared across threads).
- Next: **Traits, generics, errors and crates**, where `Box<dyn Error>`, the `?` operator and
  traits like `Copy`, `Clone` and `Send` are explained properly.
