---
id: rs-04
title: "Concurrency and async: threads, channels, tokio"
level: intermediate
minutes: 110
xp: 150
summary: Threads, move closures, Send/Sync, Arc<Mutex<T>> and channels, then async Rust with tokio — spawn, join!, select!, timeouts, spawn_blocking — and supervising child processes like ffmpeg with cancellation.
---

A desktop app is a concurrency problem with a window attached. While the user drags a slider, ClipDesk
(our sample media-tool app) is encoding three clips with an external CLI tool, reading their progress
lines, writing thumbnails to disk and watching a folder for new files. If any of that runs on the UI
thread, the window freezes. If it runs on "a thread somewhere" without rules, two jobs write the same
file, a progress counter loses updates, or a closed window leaves ten `ffmpeg` processes running.

Rust's pitch here is unusual: **most data races are compile errors**. In **Ownership, borrowing and
lifetimes** you saw that the compiler tracks who owns a value and who borrows it. This lesson shows the
same rules, plus two marker traits (`Send` and `Sync`), stretching across threads — and then how
**async/await with tokio** lets one program juggle hundreds of waiting tasks (network, timers, child
processes) cheaply.

:::info title="Words you'll meet in this lesson"
- **Thread** — an OS thread. Real parallelism: two threads can run at the same instant on two cores.
- **Data race** — two threads touch the same memory at the same time, at least one writes, with no
  synchronisation. Undefined behaviour in C/C++; a compile error in safe Rust.
- **Future** — a value representing work that *will* produce a result. Like a JS `Promise`, but **lazy**:
  nothing runs until something polls it.
- **Runtime / executor** — the library that polls futures and wakes them when I/O is ready. Rust has no
  built-in one; **tokio** is the de-facto standard (and what Tauri uses under the hood).
- **Task** — a future handed to the runtime with `tokio::spawn`; the async cousin of a thread
  (lightweight: thousands are fine).
- **Cancellation** — in async Rust, *dropping a future stops it*. No exception, no flag — it is simply
  never polled again.
:::

## Threads: spawn, join, move

The standard library gives you OS threads directly. `thread::spawn` takes a closure and returns a
`JoinHandle`; `join()` waits for the thread and hands back its return value.

```rust
use std::thread;

fn main() {
    let files = vec!["intro.mp4", "talk.mp4"];

    let handle = thread::spawn(move || {
        // `move` = this closure takes ownership of `files`
        files.iter().map(|f| f.len()).sum::<usize>()
    });

    let total = handle.join().unwrap(); // Err if the thread panicked
    println!("{total} bytes of file names");
}
```

Why the `move`? The new thread may outlive `main`'s current stack frame — the compiler can't prove the
closure finishes before `files` is dropped, so **borrowing** `files` from the spawning thread is refused.
`thread::spawn` requires its closure to be `'static`: it must own everything it uses.

```text
 main thread                     spawned thread
 ───────────                     ──────────────
 let files = vec![..]
 spawn(move || ..)  ──files──▶   owns files now
 files.len()  ✗ E0382            uses files
 handle.join() ◀──── result ───  returns usize
```

Coming from C#: `new Thread(() => ...)` happily captures locals by reference and the GC keeps them alive.
Coming from JS: there are no shared-memory threads at all (Web Workers copy messages). Rust sits in
between — real shared memory, but the compiler checks who owns what.

:::quiz id=rs-04-q1 xp=10
Will this compile?

```rust
use std::thread;

fn main() {
    let files = vec!["a.mp4", "b.mp4"];
    let h = thread::spawn(|| {
        println!("{}", files.len());
    });
    h.join().unwrap();
}
```

- [ ] Yes — `files` is still alive when `join()` returns.
- [x] No — `error[E0373]`: the closure may outlive the current function but borrows `files`; add `move`.
- [ ] No — `error[E0382]`: use of moved value `files`.
- [ ] Yes, but it prints garbage because `files` is freed early.
> `thread::spawn` needs a `'static` closure. The compiler doesn't look at `join()` to prove the borrow
> ends in time, so it reports E0373 and suggests `move`. (If you *do* `move` and then use `files` after the
> spawn, you get E0382 instead.) To borrow from the stack safely, use `thread::scope` — below.
:::

### Scoped threads: borrowing without `move`

Since Rust 1.63, `std::thread::scope` lets threads borrow local data, because the scope **guarantees**
every thread is joined before it returns:

```rust
use std::thread;

fn main() {
    let clips = vec![120, 340, 95]; // durations in seconds
    let (short, long) = thread::scope(|s| {
        let a = s.spawn(|| clips.iter().filter(|&&d| d < 100).count());
        let b = s.spawn(|| clips.iter().filter(|&&d| d >= 100).count());
        (a.join().unwrap(), b.join().unwrap())
    }); // all scoped threads are joined here, so borrowing `clips` was fine
    println!("{short} short, {long} long, still own {:?}", clips);
}
```

Use scoped threads for "split this work across cores and wait"; use `thread::spawn` for long-lived
background threads.

## Send and Sync: the two traits behind "fearless concurrency"

How does the compiler know what may cross a thread boundary? Two **auto traits** (the compiler
implements them for you when all fields have them):

| Trait | Meaning | Not implemented by |
|---|---|---|
| `Send` | A value of this type may be **moved** to another thread. | `Rc<T>`, raw pointers, `MutexGuard` |
| `Sync` | A `&T` may be **shared** between threads (`T: Sync` ⇔ `&T: Send`). | `Rc<T>`, `Cell<T>`, `RefCell<T>` |

`thread::spawn` requires `F: Send + 'static` and its result `T: Send`. So "I accidentally shared a
non-thread-safe counter" is not a 3 a.m. bug — it's a type error:

:::quiz id=rs-04-q2 xp=10
What does rustc say?

```rust
use std::{rc::Rc, thread};

fn main() {
    let count = Rc::new(5);
    let c = Rc::clone(&count);
    thread::spawn(move || println!("{c}")).join().unwrap();
}
```

- [ ] Nothing — it compiles and prints 5.
- [ ] `error[E0373]`: closure may outlive the current function.
- [x] `error[E0277]`: `` `Rc<i32>` cannot be sent between threads safely `` — use `Arc`.
- [ ] A runtime panic: "already borrowed".
> `Rc` keeps its reference count in a plain integer, so two threads cloning at once could corrupt it.
> It doesn't implement `Send`, the `spawn` bound fails, and you get E0277 (a trait-bound error).
> `Arc` ("atomically reference counted") is the thread-safe version with the same API.
:::

## Shared state: Arc<Mutex<T>> and RwLock

To **share** mutable state between threads you need two things:

1. **Shared ownership** — `Arc<T>`: several owners, freed when the last one drops.
2. **Exclusive access while mutating** — `Mutex<T>`: the data lives *inside* the mutex. You can only
   reach it through `lock()`, which returns a **guard**; the lock is released when the guard is dropped.

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let done = Arc::new(Mutex::new(Vec::<String>::new()));

    let handles: Vec<_> = ["a.mp4", "b.mp4", "c.mp4"]
        .into_iter()
        .map(|name| {
            let done = Arc::clone(&done); // each thread gets its own Arc (cheap: bumps a counter)
            thread::spawn(move || {
                // ...encode...
                done.lock().unwrap().push(name.to_string());
            }) // guard dropped at end of statement → unlocked
        })
        .collect();

    for h in handles {
        h.join().unwrap();
    }
    println!("{:?}", done.lock().unwrap().len()); // 3
}
```

Compare with C#'s `lock (obj) { ... }`: there, nothing stops you touching the list *outside* the `lock`.
In Rust the `Vec` is unreachable except through the guard — you cannot forget to lock.

- **`lock()` returns a `Result`.** If a thread panicked while holding the lock, the mutex is
  **poisoned** and later `lock()` calls return `Err` (you can still recover the data with
  `into_inner()` on the error). `.unwrap()` is the common choice: a panic elsewhere already means a bug.
- **`RwLock<T>`** allows many readers *or* one writer: `read()` / `write()`. Good for read-mostly data
  (settings, a codec list). Whether waiting writers block new readers depends on the OS — don't rely on it.
- **Atomics** (`AtomicU64`, `AtomicBool`) are lighter for a single counter or flag:
  `progress.fetch_add(1, Ordering::Relaxed)`.

:::pro title="Keep the critical section tiny"
Seniors lock, copy or mutate, and drop the guard immediately: `let n = { let g = m.lock().unwrap(); g.len() };`.
Never call out to I/O, a callback or another lock while holding a guard. And when the shape of the
problem is "workers produce results, one place consumes them", reach for a **channel** instead of a mutex
— see below.
:::

### Deadlocks: the bug Rust does not prevent

Rust prevents data races, **not deadlocks**. The classic: thread 1 locks `queue` then `stats`; thread 2
locks `stats` then `queue`. Each holds one lock and waits forever for the other.

```text
thread 1: lock(queue) ──── waits for stats ───┐
                                              │  neither can continue
thread 2: lock(stats) ──── waits for queue ───┘
```

Two more ways to hang:

- **Locking the same `Mutex` twice in one thread.** `std::sync::Mutex` is not re-entrant (unlike C#'s
  `lock`). The docs say the second `lock()` will not return — it may deadlock or panic.
  The usual cause is a temporary guard that lives longer than it looks:
  `match m.lock().unwrap().pop() { Some(x) => m.lock().unwrap().push(x), None => {} }` — temporaries in
  a `match` scrutinee (and in an `if let` condition, still in the `then` block in edition 2024) live until
  the end of that expression, so the first guard is still alive. (A plain `if m.lock().unwrap().is_empty()`
  is fine: the guard is dropped at the end of the condition.) Bind the guard to a variable once instead.
- **Holding a guard while waiting on a channel** that the other thread can only fill after taking the lock.

The cure is discipline: **one global lock order** (always `queue` before `stats`), short critical
sections, or no shared locks at all (channels). Tools like Linux's lockdep build a "held A while taking B"
graph and flag any cycle. You'll build that checker now.

:::challenge id=rs-04-c1 lang=ts xp=40
title: Lock-order checker
Write `canDeadlock(threads)`. Each thread is a list of operations: `'+a'` = lock mutex `a`
(take a guard), `'-a'` = drop the guard of `a`. Return `true` if the threads **could** deadlock:

- A thread locks a mutex it already holds (`std::sync::Mutex` is not re-entrant) → `true`.
- Whenever a thread locks `x` while holding `h`, record the edge `h → x` ("h before x").
- If the edges of **all** threads together contain a cycle (`a → b` and `b → a`, or `a → b → c → a`,
  …) → `true`. Otherwise `false`.

Dropping a guard (`'-a'`) means `a` is no longer held; dropping a mutex you don't hold is ignored.

hint: Keep a `held: string[]` per thread and a `Map<string, Set<string>>` of edges shared across threads.
hint: Cycle detection: depth-first search with three states — unvisited, on the current path, finished. Reaching a node that is *on the current path* means a cycle.

```ts starter
export function canDeadlock(threads: string[][]): boolean {
  // TODO: build the "held h while locking x" graph, then look for a cycle
  return false
}
```

```ts solution
export function canDeadlock(threads: string[][]): boolean {
  const edges = new Map<string, Set<string>>()
  for (const ops of threads) {
    const held: string[] = []
    for (const op of ops) {
      const name = op.slice(1)
      if (op[0] === '+') {
        if (held.includes(name)) return true
        for (const h of held) {
          if (!edges.has(h)) edges.set(h, new Set())
          edges.get(h)!.add(name)
        }
        held.push(name)
      } else {
        const i = held.indexOf(name)
        if (i >= 0) held.splice(i, 1)
      }
    }
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (n: string): boolean => {
    const s = state.get(n)
    if (s === 'visiting') return true
    if (s === 'done') return false
    state.set(n, 'visiting')
    for (const m of edges.get(n) ?? []) if (visit(m)) return true
    state.set(n, 'done')
    return false
  }
  for (const n of edges.keys()) if (visit(n)) return true
  return false
}
```

```ts tests
test('same lock order everywhere is safe', () => {
  expect(canDeadlock([['+queue', '+stats', '-stats', '-queue'], ['+queue', '+stats']])).toBe(false)
})
test('opposite order in two threads can deadlock', () => {
  expect(canDeadlock([['+queue', '+stats'], ['+stats', '+queue']])).toBe(true)
})
test('releasing before taking the next lock creates no edge', () => {
  expect(canDeadlock([['+a', '-a', '+b'], ['+b', '-b', '+a']])).toBe(false)
})
test('a three-thread cycle is found', () => {
  expect(canDeadlock([['+a', '+b'], ['+b', '+c'], ['+c', '+a']])).toBe(true)
})
test('three threads in a consistent order are safe', () => {
  expect(canDeadlock([['+a', '+b'], ['+b', '+c'], ['+a', '+c']])).toBe(false)
})
test('locking the same mutex twice deadlocks one thread', () => {
  expect(canDeadlock([['+a', '+a']])).toBe(true)
})
test('re-locking after dropping the guard is fine', () => {
  expect(canDeadlock([['+a', '-a', '+a'], ['-z']])).toBe(false)
})
test('no threads, no deadlock', () => {
  expect(canDeadlock([])).toBe(false)
})
```
:::

## Channels: share memory by communicating

A **channel** is a queue with a sending end and a receiving end. Workers own their data and *send*
results; one place receives them. No locks in your code at all. `std::sync::mpsc` = **multiple producer,
single consumer**: clone the `Sender` as often as you like, there is one `Receiver`.

```rust
use std::sync::mpsc;
use std::thread;

fn main() {
    let (tx, rx) = mpsc::channel::<(String, u32)>();

    for name in ["a.mp4", "b.mp4"] {
        let tx = tx.clone();
        thread::spawn(move || {
            for pct in [50, 100] {
                tx.send((name.to_string(), pct)).unwrap();
            }
        }); // this thread's Sender is dropped when it ends
    }
    drop(tx); // drop the original too — otherwise the loop below never ends

    for (name, pct) in rx {
        // iterating a Receiver ends when *every* Sender is gone
        println!("{name}: {pct}%");
    }
}
```

- `mpsc::channel()` is unbounded; `mpsc::sync_channel(n)` is **bounded**: `send` blocks when `n` messages
  are waiting. Bounded = **backpressure**: a fast producer can't eat all your RAM.
- `send` returns `Err` when the receiver is gone — that's your "the window closed, stop working" signal.
- The forgotten `drop(tx)` is the #1 "my program hangs at the end" bug with channels.

:::quiz id=rs-04-q3 xp=10
A ClipDesk worker thread sends progress over an `mpsc` channel. The main thread does
`for msg in rx { ... }` and the program **never exits**, although every worker has finished. Most likely cause?
- [ ] `mpsc` channels can't be iterated; use `try_recv` in a loop.
- [x] A `Sender` is still alive somewhere (usually the original `tx` in `main`), so the receiver keeps waiting.
- [ ] The channel is full and the workers are blocked.
- [ ] The workers panicked, which poisons the channel.
> `for msg in rx` ends only when `recv()` returns `Err`, which happens when **all** senders are dropped.
> Workers drop their clones when they finish, but the original `tx` in `main` lives until the end of `main`
> — so call `drop(tx)` after spawning.
:::

## Async Rust: why, and why it feels different

Threads are great for CPU work, but each OS thread costs a stack (often 2–8 MB reserved) and a kernel
context switch. A desktop app that waits on 50 HTTP downloads, 5 child processes and a file watcher is
mostly **waiting**. Async lets one thread juggle all of that: while a task waits, the runtime polls
another.

The syntax will look familiar from TypeScript and C#:

```rust
async fn probe(path: &str) -> Result<u64, std::io::Error> {
    let meta = tokio::fs::metadata(path).await?;
    Ok(meta.len())
}
```

But three things differ, and they cause most beginner confusion:

| | JS `Promise` / C# `Task` | Rust `Future` |
|---|---|---|
| Starts running | immediately when created | **only when polled** (`.await`ed or spawned) |
| Who runs it | built-in event loop / thread pool | **a runtime you choose** (tokio) |
| Stop it | `AbortController` / `CancellationToken`, cooperatively | **drop it** — it's never polled again |

```rust
async fn encode() -> u32 { println!("encoding"); 1 }

fn main() {
    encode(); // warning: unused implementer of `Future` that must be used
              // note: futures do nothing unless you `.await` or poll them
}
```

Nothing is printed. `encode()` only *builds* a state machine. And `main` can't `.await` because plain
`main` isn't async — you need a runtime.

:::quiz id=rs-04-q4 xp=10
In a tokio app, a function calls `save_thumbnail(&clip);` (an `async fn`) without `.await` and without
spawning it. What happens?
- [ ] The thumbnail is saved in the background, like a fire-and-forget JS promise.
- [ ] It's a compile error, E0308 mismatched types.
- [x] Nothing is saved; rustc warns "unused implementer of `Future` that must be used — futures do nothing unless you `.await` or poll them".
- [ ] It runs synchronously, blocking the caller.
> Rust futures are lazy. Calling an `async fn` returns a future; dropping it unpolled means the body
> never runs. To run it concurrently without waiting, hand it to the runtime: `tokio::spawn(...)`.
:::

## tokio basics

Add it with `cargo add tokio --features full` (the `full` feature turns on the runtime, timers, I/O,
process, signal and sync modules; trim later). Tokio is at **1.x** and keeps a stable API.

```rust
use std::time::Duration;

#[tokio::main] // builds a multi-threaded runtime and runs `main` on it (block_on)
async fn main() {
    // 1. spawn: run concurrently as an independent task, get a JoinHandle
    let handle = tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        42
    });

    // 2. join!: run several futures concurrently *in this task*, wait for all
    let (a, b) = tokio::join!(probe_len("a.mp4"), probe_len("b.mp4"));

    // 3. timeout: give up after a deadline (the inner future is dropped = cancelled)
    match tokio::time::timeout(Duration::from_secs(2), slow_call()).await {
        Ok(v) => println!("got {v}"),
        Err(_elapsed) => println!("timed out"),
    }

    let answer = handle.await.unwrap(); // Err(JoinError) if the task panicked or was aborted
    println!("{answer} {a} {b}");
}

async fn probe_len(name: &str) -> usize { name.len() }
async fn slow_call() -> u32 { tokio::time::sleep(Duration::from_secs(5)).await; 1 }
```

And `select!` waits for the **first** of several futures and **drops the rest**:

```rust
tokio::select! {
    line = lines.next_line() => { /* got a line of output */ }
    _ = tokio::time::sleep(Duration::from_secs(10)) => { /* no output for 10 s */ }
    _ = cancel.cancelled() => { /* user pressed Cancel */ }
}
```

The rules that bite people:

- **`tokio::spawn` needs `Send + 'static`**, just like `thread::spawn` — the multi-threaded runtime may
  move the task between worker threads at every `.await`. Use `move` and owned data (clone the `Arc`).
- **Dropping a `JoinHandle` does not stop the task** — it detaches it, and the task keeps running.
  To stop it, call `handle.abort()` (or keep a `JoinSet`, which aborts its tasks when dropped).
- **`select!` drops the losing branches.** If a losing future had half-read something, that partial work
  is lost. Tokio documents which methods are *cancel safe* (e.g. `mpsc::Receiver::recv`,
  `Lines::next_line` — safe; `AsyncReadExt::read_exact` — not).
- **Don't hold a `std::sync::MutexGuard` across `.await`.** The guard isn't `Send`, so the future isn't
  either, and `tokio::spawn` refuses it. Lock, copy, drop, *then* await. (Tauri's state docs echo tokio's
  advice: the std `Mutex` is fine in async code as long as you don't hold it across an `.await`; use
  `tokio::sync::Mutex` only when you must.)

:::quiz id=rs-04-q5 xp=10
Which error does this produce?

```rust
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    let progress = Arc::new(Mutex::new(0u32));
    let p = Arc::clone(&progress);
    tokio::spawn(async move {
        let mut g = p.lock().unwrap();
        *g += 1;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }).await.unwrap();
}
```

- [ ] `error[E0373]`: async block may outlive the current function.
- [x] `error: future cannot be sent between threads safely` — the `MutexGuard` is held across an `.await`.
- [ ] It compiles but deadlocks at runtime.
- [ ] `error[E0382]`: use of moved value `p`.
> `MutexGuard` is not `Send`, and it's still alive at the `.await`, so it becomes part of the future's
> state. The future isn't `Send` and fails `tokio::spawn`'s bound (rustc points to the guard with "has type
> `MutexGuard<'_, u32>` which is not `Send`"). Fix: put the lock in its own block `{ *p.lock().unwrap() += 1; }`
> before the sleep.
:::

### Blocking work and spawn_blocking

The runtime has a few worker threads (one per core by default). If a task **blocks** one —
`std::thread::sleep`, a big synchronous file hash, `std::process::Command::output()`, a CPU-heavy loop —
that thread can't poll anything else. Enough of them and every timer, socket and UI event handled by the
runtime stalls.

```rust
// ✗ blocks a runtime worker for the whole hash
let digest = hash_file_sync(&path);

// ✓ runs on tokio's separate blocking-thread pool; awaiting it doesn't block
let digest = tokio::task::spawn_blocking(move || hash_file_sync(&path)).await.unwrap();
```

Rules of thumb: async-native APIs for I/O (`tokio::fs`, `tokio::process`, `tokio::net`);
`spawn_blocking` for blocking calls you can't avoid; a dedicated thread (or the `rayon` crate) for
long CPU work. Note that `spawn_blocking` work **cannot be aborted** once it has started — check a
cancellation flag inside long loops.

:::quiz id=rs-04-q6 xp=10
ClipDesk's async command computes a perceptual hash of 2,000 images in a plain `for` loop (pure CPU,
~4 s). During that time the UI's other async commands stop responding. Best fix?
- [ ] Mark the loop body `async` and add `.await` after each image.
- [x] Move the loop into `tokio::task::spawn_blocking` (or a dedicated thread / rayon) and `.await` the handle.
- [ ] Wrap the loop in `tokio::time::timeout`.
- [ ] Use `tokio::sync::Mutex` instead of `std::sync::Mutex`.
> CPU work never yields, so it pins a runtime worker thread. `spawn_blocking` moves it to a thread pool
> meant for blocking work; the async side just awaits the result. A timeout can't interrupt code that
> never reaches an `.await`.
:::

:::job title="What you'll see at work"
Real Rust services and desktop backends are tokio all the way down: `#[tokio::main]` (or a runtime the
framework owns — Tauri runs async commands on its `tauri::async_runtime`, a tokio runtime), `Arc<State>`
passed into tasks, `mpsc` channels between a UI layer and workers, `tokio::select!` with a cancellation
branch, and `tracing` for logs. Code review will flag `std::thread::sleep` in async code, a `MutexGuard`
held across `.await`, and spawned tasks whose `JoinHandle` nobody keeps.
:::

## Child processes: driving an external CLI tool

Many desktop apps are a nice UI around a battle-tested CLI: ClipDesk shells out to `ffmpeg` to transcode.
That means *supervising* processes: start them, read their output while they run, enforce a time limit,
and **kill them** when the user cancels or the app quits.

### The synchronous way: std::process::Command

```rust
use std::process::Command;

let out = Command::new("ffmpeg")
    .args(["-hide_banner", "-i", "in.mov", "-c:v", "libx264", "out.mp4"])
    .output()?; // waits for exit, collects all stdout/stderr in memory
if !out.status.success() {
    eprintln!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
}
```

- `args([...])` passes each argument **separately** — no shell, no quoting bugs, no injection through a
  file name like `a.mp4; rm -rf ~`. Don't build a string and run it through `sh -c`.
- `output()` blocks until exit; `spawn()` returns a `Child` immediately; `status()` inherits stdio.
- Dropping a `std::process::Child` neither kills nor waits for the process.

### The async way: tokio::process

`tokio::process::Command` has the same builder API but `wait()`, `output()` and the pipes are async,
so you can read progress **while** the process runs:

```rust
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

let mut child = Command::new("ffmpeg")
    .args(["-hide_banner", "-nostats", "-progress", "pipe:1", "-i", "in.mov", "out.mp4"])
    .stdout(Stdio::piped())   // we read it
    .stderr(Stdio::null())    // or piped() and read it too — an unread full pipe blocks the child!
    .kill_on_drop(true)       // if our Child is dropped (e.g. by select!/timeout), kill the process
    .spawn()?;

let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
while let Some(line) = lines.next_line().await? {
    println!("ffmpeg: {line}");     // e.g. out_time_ms=1234000, progress=continue
}
let status = child.wait().await?;
```

```text
 ClipDesk (tokio task)                         ffmpeg (OS process)
 ─────────────────────                         ───────────────────
 Command::spawn() ───────── fork/exec ───────▶ runs
 lines.next_line().await ◀── stdout pipe ───── "progress=continue"
 select! { deadline / cancel } ── kill() ────▶ SIGKILL / TerminateProcess
 child.wait().await ◀─────── exit status ───── exits (code or signal)
```

Supervising rules:

- **Kill on every exit path.** Timeout, cancel, error, window closed. `kill_on_drop(true)` is the safety
  net; an explicit `child.kill().await` is the normal path (it also waits, so no zombie is left).
- **Drain every pipe you create.** A child that writes a lot to an unread `stderr` pipe fills the OS
  buffer (often 64 KB) and blocks forever — it looks like a hang in *your* app.
- **A kill is abrupt.** Output files may be half-written: delete them or write to a temp name and rename
  on success. For a graceful stop, many tools listen for a signal or input first (ffmpeg stops cleanly
  when it reads `q` on stdin), then you kill after a grace period.
- **Exit code `None`** (on Unix) means the process was killed by a signal.

:::quiz id=rs-04-q7 xp=10
ClipDesk wraps a running `tokio::process::Child`'s `wait()` in `tokio::time::timeout(30 s, ...)`. The
timeout fires and the future is dropped. Without any other code, what happens to the ffmpeg process?
- [x] It keeps running — dropping a `Child` doesn't kill it unless the command was built with `kill_on_drop(true)` (or you call `kill()`).
- [ ] It is killed automatically, because dropping a future cancels everything it owns.
- [ ] tokio panics with "child process leaked".
- [ ] It is paused until the next `wait()`.
> Cancelling the *future* stops your waiting, not the *process*. The OS process is independent. Tokio's
> default is to leave it running; opt in to `kill_on_drop(true)`, and still prefer an explicit `kill()`
> in the timeout/cancel branch so you can log it and clean up output files.
:::

## Cancellation, end to end

In async Rust you combine three tools:

1. **Drop** — `select!`, `timeout` and `JoinHandle::abort()` cancel by dropping a future at its next
   `.await`.
2. **A token** — `tokio_util::sync::CancellationToken` (`cargo add tokio-util`): clone it into every task;
   `token.cancel()` from the UI; tasks `select!` on `token.cancelled()`. Child tokens
   (`token.child_token()`) let you cancel one job or all of them.
3. **Cleanup** — on the cancel branch, kill the child, delete partial output, send a final "cancelled"
   event so the UI updates.

Now model that whole supervisor — a job queue with a fixed worker pool and cancellation — as a pure,
deterministic simulation.

:::challenge id=rs-04-c2 lang=ts xp=60
title: Worker pool with cancellation
Write `runPool(jobs, workers, cancels)`, a tick-by-tick simulation of a fixed pool of `workers`
(like a `Semaphore::new(workers)`). Every job has an integer `duration` ≥ 1. Time starts at `0`;
at **each tick `t`** do these steps in order:

1. **Finish**: running jobs with `start + duration === t` become `done` with `end = t` (their worker is free).
2. **Cancel**: for every cancel with `at === t` (in the given order): a running job becomes `cancelled`
   (`end = t`, keeps its `start`, frees its worker); a queued job becomes `cancelled` with `start: null`
   and `end = t` and never runs. Cancels for finished, already-cancelled or unknown ids are ignored.
3. **Start**: while a worker is free and jobs are queued, start the next queued job (input order, FIFO)
   with `start = t`.

Stop when every job is `done` or `cancelled`. Return one result per job **in input order**.

hint: Keep a `queue` (copy of `jobs`), a `running` list of `{ job, start }`, and a `Map` of results.
hint: Loop `t = 0, 1, 2, …` while `results.size < jobs.length`, doing the three steps each tick.
hint: Finishing comes before cancelling, so a cancel at the exact finish tick is ignored.

```ts starter
export type Job = { id: string; duration: number }
export type Cancel = { id: string; at: number }
export type JobResult = { id: string; status: 'done' | 'cancelled'; start: number | null; end: number }

export function runPool(jobs: Job[], workers: number, cancels: Cancel[] = []): JobResult[] {
  const results = new Map<string, JobResult>()
  // TODO: simulate ticks: 1. finish  2. cancel  3. start queued jobs
  return jobs.map(j => results.get(j.id)!)
}
```

```ts solution
export type Job = { id: string; duration: number }
export type Cancel = { id: string; at: number }
export type JobResult = { id: string; status: 'done' | 'cancelled'; start: number | null; end: number }

export function runPool(jobs: Job[], workers: number, cancels: Cancel[] = []): JobResult[] {
  const results = new Map<string, JobResult>()
  const queue = [...jobs]
  let running: { job: Job; start: number }[] = []
  for (let t = 0; results.size < jobs.length; t++) {
    // 1. finish
    for (const r of running) {
      if (r.start + r.job.duration === t) {
        results.set(r.job.id, { id: r.job.id, status: 'done', start: r.start, end: t })
      }
    }
    running = running.filter(r => r.start + r.job.duration !== t)
    // 2. cancel
    for (const c of cancels) {
      if (c.at !== t || results.has(c.id)) continue
      const ri = running.findIndex(r => r.job.id === c.id)
      if (ri >= 0) {
        results.set(c.id, { id: c.id, status: 'cancelled', start: running[ri].start, end: t })
        running.splice(ri, 1)
        continue
      }
      const qi = queue.findIndex(j => j.id === c.id)
      if (qi >= 0) {
        results.set(c.id, { id: c.id, status: 'cancelled', start: null, end: t })
        queue.splice(qi, 1)
      }
    }
    // 3. start
    while (running.length < workers && queue.length > 0) {
      running.push({ job: queue.shift()!, start: t })
    }
  }
  return jobs.map(j => results.get(j.id)!)
}
```

```ts tests
test('two workers share three jobs', () => {
  expect(runPool([{ id: 'a', duration: 3 }, { id: 'b', duration: 1 }, { id: 'c', duration: 2 }], 2)).toEqual([
    { id: 'a', status: 'done', start: 0, end: 3 },
    { id: 'b', status: 'done', start: 0, end: 1 },
    { id: 'c', status: 'done', start: 1, end: 3 },
  ])
})
test('one worker runs jobs one after another', () => {
  expect(runPool([{ id: 'a', duration: 2 }, { id: 'b', duration: 2 }], 1)).toEqual([
    { id: 'a', status: 'done', start: 0, end: 2 },
    { id: 'b', status: 'done', start: 2, end: 4 },
  ])
})
test('cancelling a running job frees its worker at once', () => {
  expect(runPool([{ id: 'a', duration: 5 }, { id: 'b', duration: 1 }], 1, [{ id: 'a', at: 2 }])).toEqual([
    { id: 'a', status: 'cancelled', start: 0, end: 2 },
    { id: 'b', status: 'done', start: 2, end: 3 },
  ])
})
test('a cancelled queued job never starts', () => {
  const jobs = [{ id: 'a', duration: 2 }, { id: 'b', duration: 2 }, { id: 'c', duration: 1 }]
  expect(runPool(jobs, 1, [{ id: 'b', at: 1 }])).toEqual([
    { id: 'a', status: 'done', start: 0, end: 2 },
    { id: 'b', status: 'cancelled', start: null, end: 1 },
    { id: 'c', status: 'done', start: 2, end: 3 },
  ])
})
test('finishing wins over a cancel at the same tick', () => {
  expect(runPool([{ id: 'a', duration: 2 }], 1, [{ id: 'a', at: 2 }])).toEqual([
    { id: 'a', status: 'done', start: 0, end: 2 },
  ])
})
test('late and unknown cancels are ignored', () => {
  expect(runPool([{ id: 'a', duration: 1 }], 3, [{ id: 'a', at: 4 }, { id: 'zzz', at: 0 }])).toEqual([
    { id: 'a', status: 'done', start: 0, end: 1 },
  ])
})
test('cancel everything at tick 0: nothing runs', () => {
  const jobs = [{ id: 'a', duration: 3 }, { id: 'b', duration: 3 }]
  expect(runPool(jobs, 1, [{ id: 'a', at: 0 }, { id: 'b', at: 0 }])).toEqual([
    { id: 'a', status: 'cancelled', start: null, end: 0 },
    { id: 'b', status: 'cancelled', start: null, end: 0 },
  ])
})
test('never more than `workers` jobs overlap', () => {
  const jobs = Array.from({ length: 7 }, (_, i) => ({ id: 'j' + i, duration: 1 + (i % 3) }))
  const res = runPool(jobs, 3)
  const end = Math.max(...res.map(r => r.end))
  for (let t = 0; t < end; t++) {
    const busy = res.filter(r => r.start !== null && r.start <= t && t < r.end).length
    expect(busy).toBeLessThanOrEqual(3)
  }
  expect(res.every(r => r.status === 'done')).toBe(true)
})
```
:::

:::lab id=rs-04-lab1 xp=120
title: ClipDesk job runner with tokio
Build `clipdesk-runner`: a tokio program that runs N child processes **with a concurrency limit**,
**streams** their output lines as they arrive, **times out** slow jobs, reports exit codes, and
**cancels** everything on Ctrl+C — without leaving processes behind. Instead of a real ffmpeg (which
you may not have installed) the package ships its own tiny `fake-encoder` binary that prints progress
lines, so the lab works the same on Linux, macOS and Windows.

You need **Rust stable** (1.85 or newer, for edition 2024): `rustup update stable`. Tested with
rustc 1.97, tokio 1.54 and tokio-util 0.7 in November 2026.

**1. Create the project**

```bash
cargo new --lib clipdesk-runner
cd clipdesk-runner
cargo add tokio --features full
cargo add tokio-util
mkdir -p src/bin tests
```

Open `Cargo.toml` and add `default-run` so plain `cargo run` picks the runner (the package has two binaries):

```toml
[package]
name = "clipdesk-runner"
version = "0.1.0"
edition = "2024"
default-run = "clipdesk-runner"

[dependencies]
tokio = { version = "1", features = ["full"] }
tokio-util = "0.7"
```

(`cargo add` writes the exact current versions, e.g. `"1.54.1"`; either form is fine.)

**2. The stand-in tool — `src/bin/fake-encoder.rs`**

```rust
//! A stand-in for a real CLI tool such as ffmpeg: prints progress lines, then exits.
//! Usage: fake-encoder <steps> <ms_per_step> [exit_code]
use std::{env, process, thread, time::Duration};

fn main() {
    let args: Vec<String> = env::args().collect();
    let steps: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(3);
    let ms: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100);
    let code: i32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

    for i in 1..=steps {
        thread::sleep(Duration::from_millis(ms));
        println!("progress={}%", i * 100 / steps); // stdout is line-buffered: one line per flush
    }
    if code != 0 {
        eprintln!("encoder failed with code {code}");
    }
    process::exit(code);
}
```

(A blocking `thread::sleep` is fine here: this is its own process, not a task on our runtime.)

**3. The supervisor — replace `src/lib.rs`**

```rust
//! ClipDesk job runner: run external tools concurrently with a limit, stream their
//! output, time them out and cancel them.
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{Semaphore, mpsc},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct Job {
    pub name: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed(Option<i32>), // exit code; None = killed by a signal (Unix)
    TimedOut,
    Cancelled,
    SpawnError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Started(String),
    Line(String, String),
    Finished(String),
}

/// Runs every job with at most `limit` children alive at once.
/// Returns the outcomes in the same order as `jobs`.
pub async fn run_jobs(
    program: PathBuf,
    jobs: Vec<Job>,
    limit: usize,
    timeout: Duration,
    cancel: CancellationToken,
    events: mpsc::Sender<Event>,
) -> Vec<Outcome> {
    let permits = Arc::new(Semaphore::new(limit));
    let mut set = JoinSet::new();

    for (index, job) in jobs.into_iter().enumerate() {
        // Each task owns its own clones: 'static + Send, as tokio::spawn requires.
        let permits = Arc::clone(&permits);
        let program = program.clone();
        let cancel = cancel.clone();
        let events = events.clone();

        set.spawn(async move {
            // Wait for a free slot, unless we are cancelled while queued.
            let _permit = tokio::select! {
                p = permits.acquire_owned() => p.expect("semaphore never closed"),
                _ = cancel.cancelled() => return (index, Outcome::Cancelled),
            };
            let _ = events.send(Event::Started(job.name.clone())).await;
            let outcome = run_one(&program, &job, timeout, &cancel, &events).await;
            let _ = events.send(Event::Finished(job.name.clone())).await;
            (index, outcome)
            // _permit is dropped here, after Finished was sent: the next job may start.
        });
    }

    let mut results: Vec<Option<Outcome>> = vec![None; set.len()];
    while let Some(joined) = set.join_next().await {
        let (index, outcome) = joined.expect("job task panicked");
        results[index] = Some(outcome);
    }
    results.into_iter().map(|o| o.expect("every job reports")).collect()
}

async fn run_one(
    program: &PathBuf,
    job: &Job,
    timeout: Duration,
    cancel: &CancellationToken,
    events: &mpsc::Sender<Event>,
) -> Outcome {
    let mut child = match Command::new(program)
        .args(&job.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true) // safety net: dropping the Child kills the process
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return Outcome::SpawnError(e.to_string()),
    };

    let stdout = child.stdout.take().expect("stdout was piped");
    let mut lines = BufReader::new(stdout).lines();

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline); // one deadline for the whole job, polled again on every loop turn

    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    let _ = events.send(Event::Line(job.name.clone(), line)).await;
                }
                Ok(None) => break, // EOF: the child closed stdout
                Err(e) => return Outcome::SpawnError(e.to_string()),
            },
            _ = &mut deadline => {
                let _ = child.kill().await;
                return Outcome::TimedOut;
            }
            _ = cancel.cancelled() => {
                let _ = child.kill().await;
                return Outcome::Cancelled;
            }
        }
    }

    tokio::select! {
        status = child.wait() => match status {
            Ok(s) if s.success() => Outcome::Succeeded,
            Ok(s) => Outcome::Failed(s.code()),
            Err(e) => Outcome::SpawnError(e.to_string()),
        },
        _ = &mut deadline => {
            let _ = child.kill().await;
            Outcome::TimedOut
        }
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            Outcome::Cancelled
        }
    }
}
```

What to notice:

- **`Semaphore` + `acquire_owned`** is the concurrency limit (the pool from challenge 2). The permit lives
  in the task and is released when the task ends.
- **`JoinSet`** owns all tasks; if `run_jobs`'s future were dropped, the set would abort them, and
  `kill_on_drop` would kill their children.
- **`tokio::pin!(deadline)`** creates one timer and lets `select!` poll it by `&mut` on every turn — a
  fresh `sleep(...)` inside the loop would restart the clock with every output line.
- `next_line()` is cancel safe, so losing a `select!` round never drops half a line.
- Errors are **values** (`Outcome::SpawnError`), not panics — a missing tool shouldn't crash the app.

**4. The program — `src/main.rs`**

```rust
use std::{env, time::Duration};

use clipdesk_runner::{Event, Job, run_jobs};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn job(name: &str, args: &[&str]) -> Job {
    Job { name: name.into(), args: args.iter().map(|s| s.to_string()).collect() }
}

#[tokio::main]
async fn main() {
    // fake-encoder is built next to this binary (target/debug/).
    let exe = env::current_exe().expect("own path");
    let encoder = exe.with_file_name(format!("fake-encoder{}", env::consts::EXE_SUFFIX));

    let jobs = vec![
        job("intro.mp4", &["4", "100"]),
        job("talk.mp4", &["4", "150"]),
        job("broken.mov", &["2", "100", "3"]),
        job("huge.mkv", &["50", "100"]), // 5 s of work: will hit the timeout
        job("outro.mp4", &["2", "100"]),
    ];
    let names: Vec<String> = jobs.iter().map(|j| j.name.clone()).collect();

    let cancel = CancellationToken::new();
    let on_ctrl_c = cancel.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            eprintln!("ctrl-c: cancelling all jobs");
            on_ctrl_c.cancel();
        }
    });

    let (tx, mut rx) = mpsc::channel::<Event>(64);
    let printer = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                Event::Started(n) => println!("[{n}] started"),
                Event::Line(n, line) => println!("[{n}] {line}"),
                Event::Finished(n) => println!("[{n}] finished"),
            }
        }
    });

    let outcomes = run_jobs(encoder, jobs, 2, Duration::from_millis(1500), cancel, tx).await;
    printer.await.expect("printer task"); // ends when every Sender is dropped

    println!("--- summary ---");
    for (name, outcome) in names.iter().zip(&outcomes) {
        println!("{name:<12} {outcome:?}");
    }
}
```

The bounded `mpsc::channel(64)` is backpressure: if the printer (later: the UI) falls behind, job tasks
wait in `send().await` instead of buffering unlimited output. `run_jobs` takes `tx` **by value**, so when
it returns every `Sender` is gone and the printer's loop ends — the async version of the `drop(tx)` rule.

**5. Run it**

```bash
cargo build
cargo run
```

`cargo build` first, so `target/debug/fake-encoder` exists next to the runner. Expected output (the
interleaving varies from run to run; the summary does not):

```text
[intro.mp4] started
[talk.mp4] started
[intro.mp4] progress=25%
[talk.mp4] progress=25%
[intro.mp4] progress=50%
...
[intro.mp4] finished
[broken.mov] started
...
[huge.mkv] started
[huge.mkv] progress=2%
...
[huge.mkv] progress=28%
[huge.mkv] finished
--- summary ---
intro.mp4    Succeeded
talk.mp4     Succeeded
broken.mov   Failed(Some(3))
huge.mkv     TimedOut
outro.mp4    Succeeded
```

Run it again and press **Ctrl+C** after about half a second: running and queued jobs are reported as
`Cancelled`. Then check that no encoder survived — Linux/macOS: `ps aux | grep fake-encoder | grep -v grep`
(prints nothing); Windows: `tasklist | findstr fake-encoder` (prints nothing).

**6. Tests — `tests/runner.rs`**

```rust
use std::{path::PathBuf, time::{Duration, Instant}};

use clipdesk_runner::{Event, Job, Outcome, run_jobs};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn encoder() -> PathBuf {
    // Cargo builds every [[bin]] before integration tests and tells us where.
    PathBuf::from(env!("CARGO_BIN_EXE_fake-encoder"))
}

fn job(name: &str, args: &[&str]) -> Job {
    Job { name: name.into(), args: args.iter().map(|s| s.to_string()).collect() }
}

async fn run(jobs: Vec<Job>, limit: usize, timeout_ms: u64, cancel: CancellationToken)
    -> (Vec<Outcome>, Vec<Event>) {
    let (tx, mut rx) = mpsc::channel(1024);
    let outcomes = run_jobs(encoder(), jobs, limit, Duration::from_millis(timeout_ms), cancel, tx).await;
    let mut events = Vec::new();
    while let Some(e) = rx.recv().await {
        events.push(e);
    }
    (outcomes, events)
}

#[tokio::test]
async fn streams_every_line_and_succeeds() {
    let (outcomes, events) = run(vec![job("a", &["4", "10"])], 1, 5_000, CancellationToken::new()).await;
    assert_eq!(outcomes, vec![Outcome::Succeeded]);
    let lines: Vec<&str> = events.iter().filter_map(|e| match e {
        Event::Line(_, l) => Some(l.as_str()),
        _ => None,
    }).collect();
    assert_eq!(lines, vec!["progress=25%", "progress=50%", "progress=75%", "progress=100%"]);
    assert_eq!(events.first(), Some(&Event::Started("a".into())));
    assert_eq!(events.last(), Some(&Event::Finished("a".into())));
}

#[tokio::test]
async fn reports_exit_code_of_a_failing_tool() {
    let (outcomes, _) = run(vec![job("bad", &["1", "10", "3"])], 1, 5_000, CancellationToken::new()).await;
    assert_eq!(outcomes, vec![Outcome::Failed(Some(3))]);
}

#[tokio::test]
async fn never_runs_more_than_the_limit() {
    let jobs = (0..6).map(|i| job(&format!("j{i}"), &["3", "20"])).collect();
    let (outcomes, events) = run(jobs, 2, 5_000, CancellationToken::new()).await;
    assert!(outcomes.iter().all(|o| *o == Outcome::Succeeded));
    let (mut running, mut max) = (0, 0);
    for e in &events {
        match e {
            Event::Started(_) => { running += 1; max = max.max(running); }
            Event::Finished(_) => running -= 1,
            Event::Line(..) => {}
        }
    }
    assert_eq!(max, 2);
}

#[tokio::test]
async fn times_out_and_kills_a_slow_tool() {
    let started = Instant::now();
    let (outcomes, _) = run(vec![job("slow", &["100", "100"])], 1, 300, CancellationToken::new()).await;
    assert_eq!(outcomes, vec![Outcome::TimedOut]);
    assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn cancel_stops_running_and_queued_jobs() {
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        trigger.cancel();
    });
    let jobs = vec![job("running", &["100", "100"]), job("queued", &["1", "10"])];
    let started = Instant::now();
    let (outcomes, _) = run(jobs, 1, 30_000, cancel).await;
    assert_eq!(outcomes, vec![Outcome::Cancelled, Outcome::Cancelled]);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn missing_program_is_a_spawn_error_not_a_panic() {
    let (tx, _rx) = mpsc::channel(16);
    let outcomes = run_jobs(PathBuf::from("./definitely-not-here"), vec![job("x", &[])], 1,
        Duration::from_secs(1), CancellationToken::new(), tx).await;
    assert!(matches!(outcomes[0], Outcome::SpawnError(_)));
}
```

```bash
cargo test
cargo clippy --all-targets
```

Expected for `tests/runner.rs` (order of test lines varies; Cargo also prints empty `running 0 tests`
blocks for the library, the binaries and the doc-tests):

```text
running 6 tests
test missing_program_is_a_spawn_error_not_a_panic ... ok
test reports_exit_code_of_a_failing_tool ... ok
test streams_every_line_and_succeeds ... ok
test never_runs_more_than_the_limit ... ok
test cancel_stops_running_and_queued_jobs ... ok
test times_out_and_kills_a_slow_tool ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

and `cargo clippy` reports no warnings.

:::tip
Break it on purpose to see the tests earn their keep: delete the `let deadline = ...` and
`tokio::pin!(deadline)` lines and write `_ = tokio::time::sleep(timeout) => { ... }` directly in the
loop's `select!`. Now `times_out_and_kills_a_slow_tool` fails after about 10 s with `Succeeded`:
every output line restarts the timer, so a chatty process never times out.
:::

:::pro title="Where this goes next"
In **Tauri 2: a desktop app with a web frontend** this `run_jobs` becomes the body of an async command:
the frontend calls it, `Event`s are forwarded to the window, and the `CancellationToken` lives in managed
state so a "Cancel" button can reach it. Packaging an external binary with the app (a "sidecar") and
allowing it to run is covered in **Tauri security: capabilities, permissions and plugins**.
:::

- [ ] `cargo run` shows interleaved progress lines from two jobs at a time and the summary above
- [ ] `huge.mkv` ends as `TimedOut` after about 1.5 s and `broken.mov` as `Failed(Some(3))`
- [ ] Pressing Ctrl+C reports running and queued jobs as `Cancelled`, and no `fake-encoder` process is left
- [ ] `cargo test` passes all 6 tests
- [ ] `cargo clippy --all-targets` reports no warnings
:::

## How it breaks in practice

| Symptom | Usual cause | Fix |
|---|---|---|
| `E0373` on `thread::spawn` | closure borrows a local | `move`, clone what you need first, or `thread::scope` |
| `E0277 ... cannot be sent between threads safely` | `Rc`, `RefCell` or a non-`Send` type inside a thread/task | `Arc`, `Mutex`/`RwLock`, or keep it on one thread |
| `future cannot be sent between threads safely` | `MutexGuard` (or `Rc`) alive across `.await` | drop the guard in an inner block before awaiting |
| App freezes, CPU at 0 % | deadlock: two locks in opposite order, or the same `Mutex` locked twice | one lock order; bind the guard once; prefer channels |
| `for msg in rx` never ends | a `Sender` is still alive | `drop(tx)` after spawning workers |
| Async code "does nothing" | future created but never awaited/spawned | `.await` it or `tokio::spawn` it; read the `unused_must_use` warning |
| All timers/IPC stall for seconds | blocking call inside async (`thread::sleep`, sync I/O, CPU loop) | `spawn_blocking`, async APIs, or a dedicated thread |
| Closing the window leaves `ffmpeg` running | `Child` dropped without `kill_on_drop(true)`; detached `JoinHandle` | kill in every branch, `kill_on_drop(true)`, keep tasks in a `JoinSet` |
| Child process hangs forever | stderr piped but never read, pipe buffer full | `Stdio::null()`, inherit, or read both pipes concurrently |
| Timeout never fires on a chatty process | `sleep(timeout)` created inside the loop | create the deadline once, `tokio::pin!` it, poll `&mut deadline` |
| `there is no reactor running` panic | tokio API called outside a runtime (e.g. from a plain thread) | run inside `#[tokio::main]` / the framework's runtime, or pass a `Handle` |

:::cards id=rs-04-cards1 xp=15 title="Concurrency & async in Rust"
Q: Why does `thread::spawn` usually need `move`?
A: The closure must be `'static` — the thread may outlive the current stack frame, so it must own
   what it uses. `thread::scope` lets threads borrow because it joins them before returning.
Q: `Send` vs `Sync`?
A: `Send`: a value may be moved to another thread. `Sync`: `&T` may be shared between threads.
   `Rc` is neither; `Arc<Mutex<T>>` is both (for `T: Send`).
Q: What does a poisoned `Mutex` mean?
A: A thread panicked while holding the guard. `lock()` then returns `Err`; `into_inner()` on the error
   still gives you the data.
Q: Does Rust prevent deadlocks?
A: No — only data races. Use one global lock order, short critical sections, or channels.
Q: When does `for msg in rx` end?
A: When every `Sender` has been dropped (including the original one in the spawning code).
Q: Are Rust futures eager like JS promises?
A: No, lazy: nothing runs until the future is polled — `.await`ed or handed to `tokio::spawn`.
Q: `tokio::join!` vs `tokio::spawn`?
A: `join!` runs futures concurrently inside the current task and waits for all. `spawn` makes an
   independent task (`Send + 'static`) that runs even if you never await its `JoinHandle`.
Q: How do you cancel async work in Rust?
A: Drop the future (`select!`, `timeout`, `JoinHandle::abort`), or cooperatively with a
   `CancellationToken` that tasks `select!` on. `spawn_blocking` work can't be aborted once started.
Q: Does dropping a `tokio::process::Child` kill the process?
A: Not by default. Build the command with `kill_on_drop(true)` and call `child.kill().await` on
   timeout/cancel paths.
Q: Where does CPU-heavy work go in a tokio app?
A: `tokio::task::spawn_blocking`, a dedicated thread, or rayon — never directly in an async task.
:::

## Recap

- `thread::spawn` needs an owning (`move`, `'static`) closure; `thread::scope` lets threads borrow.
  `join()` returns the result or the panic.
- `Send` and `Sync` make "shared a non-thread-safe value" a compile error (E0277). `Rc` → `Arc`.
- Shared mutable state is `Arc<Mutex<T>>` / `Arc<RwLock<T>>`; the data is only reachable through the
  guard. Rust prevents data races, **not deadlocks** — keep one lock order and short critical sections.
- Channels (`mpsc`) move data instead of sharing it; bounded channels give backpressure; the receiver
  ends when every sender is dropped.
- Rust futures are **lazy** and need a runtime. tokio gives `#[tokio::main]`, `spawn` (`Send + 'static`),
  `join!`, `select!`, `timeout` and async I/O. Never block a runtime thread — use `spawn_blocking`.
- Cancellation = dropping a future, plus a `CancellationToken` for cooperative stop and cleanup.
- Supervising CLI tools: `Command` with separate `args`, piped stdout read line by line,
  `kill_on_drop(true)` plus explicit `kill()` on timeout/cancel, drain every pipe, clean up partial output.
- Next: **Tauri 2: a desktop app with a web frontend** turns this runner into commands and events for a
  real window.
