---
id: rs-07
title: "One app, every platform: Windows, macOS, Linux, Android, iOS"
level: advanced
minutes: 120
xp: 150
summary: Five webviews, one Rust core. Learn what differs per OS, gate code and dependencies with cfg, resolve paths properly, handle deep links, sign in through the system browser with PKCE, and take a Tauri 2 app to mobile.
---

"Write once, run everywhere" is half true for Tauri. Your Rust core compiles to every target, and your
web frontend is the same files on every target. But the thing that *shows* those files, the webview,
is a different browser engine on each operating system. The OS also differs in where files go, how
links open apps, how users sign in, and which features exist at all. A tray icon makes sense on
Windows and does not exist on iOS.

This lesson follows **ClipDesk**, a small media-tool app (trim clips, make thumbnails), from "works on
my laptop" to "builds for five platforms". It assumes **Tauri 2: a desktop app with a web frontend**
(project layout, commands, `tauri.conf.json`) and **Tauri security: capabilities, permissions and
plugins** (capability files). Bundling, code signing and auto-update are covered in **Shipping:
bundles, signing, auto-update and CI**. Here the topic is *code and config that differ per platform*.

:::info title="Words you'll meet in this lesson"
- **Target** — what you compile *for*: a CPU + OS combination such as `x86_64-pc-windows-msvc` or
  `aarch64-linux-android` (the "target triple").
- **Webview** — an embeddable browser engine without the browser UI. Tauri does not ship one; it
  uses the one the OS provides.
- **cfg** — Rust's *conditional compilation*: code that is compiled only when a condition about the
  target is true. Think C# `#if WINDOWS`, but checked by the compiler on every build.
- **Deep link** — a URL like `clipdesk://open?clip=intro` that the OS routes to your app.
- **PKCE** ("pixy") — *Proof Key for Code Exchange*, the OAuth extension that lets an app with no
  secret sign users in safely.
:::

## Five webviews, one app

```text
                 ┌───────────── your frontend (HTML/CSS/JS, identical) ─────────────┐
                 │                                                                   │
   Windows       macOS            Linux             Android              iOS
   WebView2      WKWebView        WebKitGTK         System WebView       WKWebView
   (Chromium)    (WebKit)         (WebKit)          (Chromium)           (WebKit)
   updates       updates with     version from      updates via          updates with
   itself        macOS            your distro       Play Store/provider  iOS
                 │                                                                   │
                 └───────────── Rust core (same crate, compiled per target) ─────────┘
```

Why doesn't Tauri just bundle Chromium like Electron does? Size and patching. A Tauri installer
is a few MB because the engine is already on the machine. When the OS vendor fixes a security
bug in the engine, your app gets the fix too. The price is that **you ship into five browsers you don't
control**, and two engine families:

| | Windows | macOS | Linux | Android | iOS |
|---|---|---|---|---|---|
| Engine | WebView2 (Edge/Chromium) | WKWebView (WebKit) | WebKitGTK (`webkit2gtk-4.1`) | Android System WebView (Chromium) | WKWebView (WebKit) |
| Version decided by | Evergreen runtime, self-updates | macOS version | distro package | device's WebView provider | iOS version |
| App origin | `http://tauri.localhost` | `tauri://localhost` | `tauri://localhost` | `http://tauri.localhost` | `tauri://localhost` |
| Inspect it with | right-click → Inspect (Edge DevTools) | right-click → Inspect (Safari Web Inspector) | right-click → Inspect (WebKit inspector) | `chrome://inspect` in desktop Chrome | Safari → Develop menu on a Mac |

Things that really differ:

- **Web features.** A CSS or JS feature that works in Chromium can be missing in an older WebKit.
  Check "Safari" on caniuse.com for macOS/iOS (find the Safari version for each macOS release on
  Tauri's *Webview Versions* page). For Linux, check WebKitGTK release notes and your users' distros.
  An old LTS distro can ship a WebKitGTK that is years behind.
- **Media codecs.** This matters for ClipDesk. WebView2 and Safari's WebKit decode H.264/AAC out of
  the box. **WebKitGTK plays media through GStreamer**, so whether `<video src="clip.mp4">` plays on
  Linux depends on which GStreamer plugin packages the user has installed (H.264 usually needs
  `gst-libav` or the distro's equivalent). HEVC and AV1 depend on hardware and OS version
  everywhere. Feature-detect with `video.canPlayType('video/mp4; codecs="avc1.42E01E"')` or
  `MediaSource.isTypeSupported(...)`. Don't decide by user agent.
- **Origins.** The app origin is `http://tauri.localhost` on Windows/Android and `tauri://localhost`
  elsewhere (`app.windows[].useHttpsScheme: true` switches Windows/Android to `https://tauri.localhost`;
  changing it between releases moves the app's localStorage and IndexedDB). Code that hard-codes an origin (CORS allow-lists on your API, `postMessage` checks,
  cookie domains) breaks on half the platforms.
- **DevTools in release builds.** Debug builds have the inspector. Release builds don't, unless you
  enable the `devtools` Cargo feature of `tauri`. On macOS that feature uses private APIs, which
  the Mac App Store rejects.

:::job title="What you'll see at work"
Bug reports that start with "only on Linux" or "only on the Mac". The first triage question is
*which engine and which version*. Teams ask for it in their issue template. ClipDesk's "About"
dialog can print `navigator.userAgent` plus the OS version from Rust. Expect a test matrix in
CI with at least one Windows, one macOS and one Linux runner.
:::

:::quiz id=rs-07-q1 xp=10
ClipDesk's `<video>` element plays an H.264 MP4 fine on Windows and macOS. On a fresh Linux
install the video stays black, but the rest of the UI works. What is the most likely cause?
- [ ] Tauri disables video on Linux unless you enable a Cargo feature.
- [x] WebKitGTK decodes media through GStreamer, and the plugin that handles H.264 isn't installed.
- [ ] Linux webviews only support WebM, never MP4.
- [ ] The capability file is missing a `media:allow-play` permission.
> On Linux the webview is WebKitGTK, which delegates media playback to GStreamer. Codec support
> depends on which GStreamer plugin packages are installed (for H.264, typically `gst-libav`). Feature-detect with
> `canPlayType` / `MediaSource.isTypeSupported` and show a helpful message (or decode in Rust)
> instead of a black box. Capabilities control IPC commands, not HTML media.
:::

## Conditional compilation: `#[cfg]`, `cfg!` and Tauri's `desktop` / `mobile`

In TypeScript you'd write `if (process.platform === 'win32')`. It is a runtime check, and both
branches have to exist and type-check on every platform. Rust works differently. **`#[cfg(...)]`
removes code before type checking.** On Linux, a `#[cfg(windows)]` function is not compiled at
all, so it can call Windows-only APIs that don't exist on Linux. (C# readers: this is
`#if WINDOWS ... #endif`, but with structured conditions instead of symbols.)

### The predicates

```rust
#[cfg(target_os = "macos")]          // "windows" | "macos" | "linux" | "android" | "ios" | ...
#[cfg(target_family = "unix")]       // "unix" | "windows" | "wasm"
#[cfg(unix)]                         // shorthand for target_family = "unix" (Linux, macOS, Android, iOS)
#[cfg(windows)]                      // shorthand for target_family = "windows"
#[cfg(feature = "tray")]             // a Cargo feature of THIS crate is enabled
#[cfg(debug_assertions)]             // a debug build (cargo build without --release)
#[cfg(all(unix, not(target_os = "macos")))]           // all(...) = AND, not(...) = NOT
#[cfg(any(target_os = "linux", target_os = "macos"))] // any(...) = OR
```

The rules are simple: `all()` with no arguments is true, `any()` with no arguments is false, `not`
takes exactly one argument, and **an unknown name is just false**. It is not an error, so a typo
such as `target_os = "macOS"` quietly compiles the code out. Recent Rust versions warn about unknown
cfg *names* and well-known *values* (`unexpected_cfgs`). Read those warnings.

### Three ways to use a condition

```rust
// 1. Attribute: the item exists only on matching targets.
#[cfg(windows)]
fn default_export_dir() -> &'static str { "Videos" }
#[cfg(not(windows))]
fn default_export_dir() -> &'static str { "Movies" }

// 2. Attribute on a block or statement (inside a function).
fn setup() {
    #[cfg(target_os = "linux")]
    {
        println!("checking GStreamer plugins...");
    }
}

// 3. cfg!(): a macro that becomes the literal `true` or `false`. BOTH branches are still compiled.
fn label() -> &'static str {
    if cfg!(target_os = "macos") { "⌘ + E to export" } else { "Ctrl + E to export" }
}
```

`cfg!` is great when both branches compile everywhere (strings, numbers, calling cross-platform
code). It is **not** a way to call platform-only code. The compiler still type-checks the
`false` branch, and if that branch names a function that was `#[cfg]`'d out, the build fails.
`cfg_attr` applies an attribute conditionally. You've already seen it in every Tauri `lib.rs`:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)] // only on Android/iOS: generate the mobile entry point
pub fn run() { /* ... */ }
```

### Tauri's `desktop` and `mobile`

`desktop` and `mobile` are **not** built-in Rust cfgs. Your app's `build.rs` calls
`tauri_build::build()`, and that build script emits `cargo:rustc-cfg=desktop` (or `mobile` when the
target OS is Android or iOS) for your crate. So:

- `#[cfg(desktop)]` / `#[cfg(mobile)]` work **in the crate whose `build.rs` runs `tauri_build`**,
  which is your `src-tauri` app crate.
- In a separate library crate of your workspace (say `clipdesk-core`) they are simply unknown,
  which means false. There, use `#[cfg(any(target_os = "android", target_os = "ios"))]`.

:::quiz id=rs-07-q2 xp=15
Will this compile when you run `cargo tauri android build`?

```rust
#[cfg(desktop)]
mod tray;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            tray::create(app)?;
            Ok(())
        })
        // ...
}
```

- [ ] Yes. `cfg(desktop)` is false on Android, so the call is skipped at runtime.
- [x] No: `error[E0433]: cannot find module or crate tray in this scope`, because the module was compiled out but the call wasn't.
- [ ] No: `error[E0308]: mismatched types`.
- [ ] Yes, but it panics on Android when `setup` runs.
> `#[cfg]` removes the `tray` module on mobile, and nothing else is removed. The call site still names
> `tray::create`, so rustc reports E0433 (a path it can't resolve; older compilers word it "failed to
> resolve") and adds the note "found an item that was configured out". Gate the call too: put `#[cfg(desktop)]` on the statement
> `tray::create(app)?;`.
:::

:::quiz id=rs-07-q3 xp=15
`enable_dark_title_bar` is declared with `#[cfg(windows)]`. On Linux, does this compile?

```rust
fn apply_theme(window: &tauri::WebviewWindow) {
    if cfg!(windows) {
        enable_dark_title_bar(window);
    }
}
```

- [ ] Yes. `cfg!(windows)` is `false`, so the call is removed.
- [ ] Yes, but with an `unexpected_cfgs` warning.
- [x] No: `error[E0425]: cannot find function enable_dark_title_bar in this scope`.
- [ ] No: `error[E0599]: no method named enable_dark_title_bar`.
> `cfg!` expands to the literal `false`, but `if false { ... }` is still ordinary code that must
> type-check, so the function has to exist. Use the attribute form when the code inside only exists on one
> platform: `#[cfg(windows)] enable_dark_title_bar(window);`.
:::

## Target-scoped dependencies in `Cargo.toml`

Gating your own code is half the job. The other half is **not compiling (or downloading,
or linking) crates that make no sense on a target.** The updater plugin and the single-instance
plugin are desktop-only. A tray icon is a feature flag of `tauri` that only matters on desktop. Cargo
has *target tables* for this:

```toml
# src-tauri/Cargo.toml

# Every target (desktop AND mobile)
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-deep-link = "2"

# Only when building for Windows, macOS or Linux
[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri = { version = "2", features = ["tray-icon"] }   # same crate: features are ADDED on these targets
tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }
tauri-plugin-updater = "2"

# Only on Linux, e.g. a crate that talks to D-Bus
[target.'cfg(target_os = "linux")'.dependencies]
# zbus = "5"
```

`cargo add` can write these tables for you. Tauri's updater docs use exactly this command:

```bash
cargo add tauri-plugin-updater --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'
```

Two details trip people up:

1. **Cargo evaluates the target table, not your build script.** `[target.'cfg(desktop)'.dependencies]`
   does *not* work: `desktop` is emitted by `tauri_build` later, while the crate is compiled. Cargo
   only knows the built-in target cfgs (`target_os`, `target_family`, `unix`, `windows`,
   `target_arch`, `target_env`, `target_pointer_width`, ...). Cargo features don't work in a target
   table either: Cargo warns that `feature = ...` "is not supported for selecting dependencies", and
   the table never matches. For "only with feature X", use an
   optional dependency (`optional = true`) plus `[features] tray = ["dep:..."]`.
2. **The dependency and the code that uses it must be gated together.** If the updater crate only
   exists on desktop, every `use tauri_plugin_updater::...` must also sit behind `#[cfg(desktop)]`.
   On Android the crate isn't there, and rustc reports **E0432 unresolved import** (or **E0433** for a
   path like `tauri_plugin_updater::Builder`).

```text
 cargo build --target aarch64-linux-android
   │
   ├─ Cargo: evaluate [target.'cfg(...)'] tables for THIS target → pick crates & features
   ├─ build.rs (tauri_build) → emits cfg "mobile"
   └─ rustc: compile your crate; #[cfg(desktop)] items disappear, #[cfg(mobile)] items stay
```

:::quiz id=rs-07-q4 xp=15
A teammate writes this so the updater is only pulled in for desktop builds. What happens?

```toml
[target.'cfg(desktop)'.dependencies]
tauri-plugin-updater = "2"
```

- [ ] It works: `desktop` is set by Tauri for every desktop target.
- [x] The table never matches. `desktop` is a cfg that `tauri_build` passes to rustc, and Cargo doesn't see it, so the updater is missing on desktop too and `use tauri_plugin_updater` fails with E0432.
- [ ] Cargo rejects the manifest with a parse error.
- [ ] It works only when you build with `cargo tauri build`, not with `cargo build`.
> Cargo picks target dependencies *before* any build script runs, using only the target's built-in
> cfgs, and an unknown cfg like `desktop` evaluates to false. Spell it out instead:
> `cfg(any(target_os = "macos", windows, target_os = "linux"))`. In Rust *code* (inside the app
> crate) `#[cfg(desktop)]` is fine.
:::

:::challenge id=rs-07-c1 lang=ts xp=50
title: A cfg() evaluator for target dependencies
Cargo decides which `[target.'…'.dependencies]` apply by evaluating a cfg expression against the
target. Model it in TypeScript.

```ts
type Target = {
  triple: string                     // "x86_64-pc-windows-msvc"
  os: string                         // target_os: "windows" | "macos" | "linux" | "android" | "ios"
  family: string                     // target_family: "windows" | "unix"
  features: string[]                 // enabled Cargo features
  flags?: string[]                   // other bare names that are set, e.g. ["debug_assertions"]
}
```

1. `evalCfg(expr, target)` evaluates an expression **without** the outer `cfg(...)`, for example
   `any(target_os = "macos", windows)`:
   - `all(a, b, …)` is AND (`all()` is `true`), `any(…)` is OR (`any()` is `false`), and `not(x)` takes
     **exactly one** argument. Throw an `Error` otherwise.
   - `target_os = "…"`, `target_family = "…"`, `feature = "…"` compare against the target. Any other
     `key = "value"` is `false`.
   - Bare names: `unix` / `windows` mean `family` equals that name. Any other bare name is true only if
     it is in `flags`, so unknown names are `false`, like rustc.
   - Whitespace is insignificant. Throw an `Error` on malformed input (unbalanced parentheses,
     trailing tokens, a missing value, or an unknown operator like `xor(...)`).
2. `activeDependencies(deps, target)` returns the names of the dependencies that apply, in order. A
   dependency without `target` always applies. A `target` that starts with `cfg(` and ends with `)`
   is evaluated. Any other `target` string is a target triple and must equal `target.triple`.

The tokenizer is written for you.

hint: Write a recursive-descent parser: `parsePred()` reads an identifier, then looks at the next token: `(` means operator, `=` means key/value, anything else means a bare name.
hint: For `all`/`any`/`not`, collect arguments with a loop: parse a predicate, then accept `,` or stop at `)`. Allow a trailing comma like rustc does.
hint: Evaluate all arguments (no short-circuit needed); `args.every(Boolean)` / `args.some(Boolean)`.
hint: After the top-level predicate, the position must be at the end of the tokens, or you throw.

```ts starter
type Target = { triple: string; os: string; family: string; features: string[]; flags?: string[] }
type Dep = { name: string; target?: string }
type Tok = { kind: 'ident' | 'str' | 'punct'; value: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if ('(),='.includes(c)) { toks.push({ kind: 'punct', value: c }); i++; continue }
    if (c === '"') {
      const end = src.indexOf('"', i + 1)
      if (end < 0) throw new Error('unterminated string')
      toks.push({ kind: 'str', value: src.slice(i + 1, end) }); i = end + 1; continue
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (!m) throw new Error(`unexpected character ${c}`)
    toks.push({ kind: 'ident', value: m[0] }); i += m[0].length
  }
  return toks
}

export function evalCfg(expr: string, target: Target): boolean {
  const toks = tokenize(expr)
  // TODO: parse and evaluate
  return false
}

export function activeDependencies(deps: Dep[], target: Target): string[] {
  // TODO
  return deps.map(d => d.name)
}
```

```ts solution
type Target = { triple: string; os: string; family: string; features: string[]; flags?: string[] }
type Dep = { name: string; target?: string }
type Tok = { kind: 'ident' | 'str' | 'punct'; value: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if ('(),='.includes(c)) { toks.push({ kind: 'punct', value: c }); i++; continue }
    if (c === '"') {
      const end = src.indexOf('"', i + 1)
      if (end < 0) throw new Error('unterminated string')
      toks.push({ kind: 'str', value: src.slice(i + 1, end) }); i = end + 1; continue
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (!m) throw new Error(`unexpected character ${c}`)
    toks.push({ kind: 'ident', value: m[0] }); i += m[0].length
  }
  return toks
}

export function evalCfg(expr: string, target: Target): boolean {
  const toks = tokenize(expr)
  let pos = 0
  const peek = () => toks[pos]
  const isPunct = (v: string) => peek()?.kind === 'punct' && peek()!.value === v
  const expect = (v: string) => {
    if (!isPunct(v)) throw new Error(`expected ${v}`)
    pos++
  }

  function parsePred(): boolean {
    const t = peek()
    if (!t || t.kind !== 'ident') throw new Error('expected a cfg name')
    pos++
    const name = t.value
    if (isPunct('(')) {
      pos++
      const args: boolean[] = []
      while (!isPunct(')')) {
        args.push(parsePred())
        if (isPunct(',')) pos++
        else if (!isPunct(')')) throw new Error('expected , or )')
      }
      expect(')')
      if (name === 'all') return args.every(Boolean)
      if (name === 'any') return args.some(Boolean)
      if (name === 'not') {
        if (args.length !== 1) throw new Error('not() takes exactly one argument')
        return !args[0]
      }
      throw new Error(`unknown operator ${name}`)
    }
    if (isPunct('=')) {
      pos++
      const v = peek()
      if (!v || v.kind !== 'str') throw new Error('expected a string value')
      pos++
      if (name === 'target_os') return target.os === v.value
      if (name === 'target_family') return target.family === v.value
      if (name === 'feature') return target.features.includes(v.value)
      return false
    }
    if (name === 'unix' || name === 'windows') return target.family === name
    return (target.flags ?? []).includes(name)
  }

  const result = parsePred()
  if (pos !== toks.length) throw new Error('unexpected trailing input')
  return result
}

export function activeDependencies(deps: Dep[], target: Target): string[] {
  return deps
    .filter(d => {
      if (d.target === undefined) return true
      const t = d.target.trim()
      if (t.startsWith('cfg(') && t.endsWith(')')) return evalCfg(t.slice(4, -1), target)
      return t === target.triple
    })
    .map(d => d.name)
}
```

```ts tests
const win: Target = { triple: 'x86_64-pc-windows-msvc', os: 'windows', family: 'windows', features: [] }
const mac: Target = { triple: 'aarch64-apple-darwin', os: 'macos', family: 'unix', features: ['tray'] }
const linux: Target = { triple: 'x86_64-unknown-linux-gnu', os: 'linux', family: 'unix', features: [], flags: ['debug_assertions'] }
const android: Target = { triple: 'aarch64-linux-android', os: 'android', family: 'unix', features: [] }
const ios: Target = { triple: 'aarch64-apple-ios', os: 'ios', family: 'unix', features: [] }
const DESKTOP = 'any(target_os = "macos", windows, target_os = "linux")'

test('key = value predicates', () => {
  expect(evalCfg('target_os = "linux"', linux)).toBe(true)
  expect(evalCfg('target_os = "linux"', mac)).toBe(false)
  expect(evalCfg('target_family = "unix"', android)).toBe(true)
  expect(evalCfg('feature = "tray"', mac)).toBe(true)
  expect(evalCfg('feature = "tray"', win)).toBe(false)
})

test('unix and windows shorthands', () => {
  expect(evalCfg('unix', mac)).toBe(true)
  expect(evalCfg('unix', win)).toBe(false)
  expect(evalCfg('windows', win)).toBe(true)
  expect(evalCfg('windows', ios)).toBe(false)
})

test('all / any / not', () => {
  for (const t of [win, mac, linux]) expect(evalCfg(DESKTOP, t)).toBe(true)
  for (const t of [android, ios]) expect(evalCfg(DESKTOP, t)).toBe(false)
  expect(evalCfg('all(unix, not(target_os = "macos"))', linux)).toBe(true)
  expect(evalCfg('all(unix, not(target_os = "macos"))', mac)).toBe(false)
  expect(evalCfg('not(windows)', android)).toBe(true)
})

test('empty all() is true, empty any() is false', () => {
  expect(evalCfg('all()', win)).toBe(true)
  expect(evalCfg('any()', win)).toBe(false)
})

test('unknown names are false, flags are true', () => {
  expect(evalCfg('desktop', mac)).toBe(false)          // Cargo does not see tauri_build's cfg!
  expect(evalCfg('target_os = "macOS"', mac)).toBe(false) // case matters
  expect(evalCfg('target_vendor = "apple"', mac)).toBe(false)
  expect(evalCfg('debug_assertions', linux)).toBe(true)
  expect(evalCfg('all(debug_assertions, windows)', linux)).toBe(false)
})

test('whitespace and trailing commas are fine', () => {
  expect(evalCfg('  any (\n target_os="ios" ,\n target_os = "android", )', ios)).toBe(true)
})

test('malformed input throws', () => {
  expect(() => evalCfg('not(unix, windows)', mac)).toThrow()
  expect(() => evalCfg('not()', mac)).toThrow()
  expect(() => evalCfg('any(unix', mac)).toThrow()
  expect(() => evalCfg('unix)', mac)).toThrow()
  expect(() => evalCfg('unix windows', mac)).toThrow()
  expect(() => evalCfg('target_os =', mac)).toThrow()
  expect(() => evalCfg('xor(unix, windows)', mac)).toThrow()
})

test('activeDependencies picks per target', () => {
  const deps = [
    { name: 'tauri' },
    { name: 'tauri-plugin-deep-link' },
    { name: 'tauri-plugin-single-instance', target: `cfg(${DESKTOP})` },
    { name: 'tauri-plugin-updater', target: `cfg(${DESKTOP})` },
    { name: 'zbus', target: 'cfg(target_os = "linux")' },
    { name: 'windows-sys', target: 'x86_64-pc-windows-msvc' },
  ]
  expect(activeDependencies(deps, android)).toEqual(['tauri', 'tauri-plugin-deep-link'])
  expect(activeDependencies(deps, linux)).toEqual([
    'tauri', 'tauri-plugin-deep-link', 'tauri-plugin-single-instance', 'tauri-plugin-updater', 'zbus',
  ])
  expect(activeDependencies(deps, win)).toEqual([
    'tauri', 'tauri-plugin-deep-link', 'tauri-plugin-single-instance', 'tauri-plugin-updater', 'windows-sys',
  ])
  expect(activeDependencies([{ name: 'x', target: 'cfg(desktop)' }], mac)).toEqual([])
})
```
:::

## Paths: ask the OS, never hard-code

Every OS has rules for where an app may keep its files, and users, backup tools, sandboxes and
uninstallers depend on them. `C:\Users\me\AppData\Roaming\clipdesk` is right on one machine
and wrong on all the others. On macOS and iOS a sandboxed app can't even write outside its
container. Tauri's **path resolver** asks the OS for the correct directory, and its
`app_*` variants add your bundle **identifier** (`com.example.clipdesk`) so apps don't collide:

| Method (Rust: `app.path().…`, JS: `@tauri-apps/api/path`) | Use it for | Linux | macOS | Windows |
|---|---|---|---|---|
| `app_config_dir()` / `appConfigDir()` | settings the user chose | `~/.config/<id>` | `~/Library/Application Support/<id>` | `%APPDATA%\<id>` (Roaming) |
| `app_data_dir()` / `appDataDir()` | the user's data (project files, DB) | `~/.local/share/<id>` | `~/Library/Application Support/<id>` | `%APPDATA%\<id>` |
| `app_local_data_dir()` | big, machine-specific data (not roamed) | `~/.local/share/<id>` | `~/Library/Application Support/<id>` | `%LOCALAPPDATA%\<id>` |
| `app_cache_dir()` / `appCacheDir()` | thumbnails, transcodes: anything you can rebuild | `~/.cache/<id>` | `~/Library/Caches/<id>` | `%LOCALAPPDATA%\<id>` |
| `app_log_dir()` / `appLogDir()` | logs | `~/.local/share/<id>/logs` | `~/Library/Logs/<id>` | `%LOCALAPPDATA%\<id>\logs` |
| `resource_dir()` | files you bundled with the app (read-only) | depends on install type | `<App>.app/Contents/Resources` | next to the `.exe` |

(Linux honours `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME` and `$XDG_CACHE_HOME`. On Android and iOS the same
calls return directories inside the app's sandbox.)

```rust
use tauri::Manager; // brings app.path() into scope

let config_dir = app.path().app_config_dir()?;   // tauri::Result<PathBuf>
std::fs::create_dir_all(&config_dir)?;           // it may not exist yet: create it
let settings = config_dir.join("settings.json"); // join(), never format!("{}/{}") or a hard-coded "\\"
```

Two more rules. **Never write next to the executable.** `Program Files`, `/usr/bin` and a signed
`.app` bundle are read-only, and writing there breaks code signatures. **Treat resources as
read-only**: copy a bundled template into `app_data_dir` before you edit it.

:::quiz id=rs-07-q5 xp=10
Where should ClipDesk keep each of these? Select all correct pairings.
- [x] Generated thumbnails → `app_cache_dir()`. They can be rebuilt, and the OS may clear them.
- [ ] The user's settings → `std::env::current_exe()` directory, so they move with the app.
- [x] The user's settings → `app_config_dir()`.
- [ ] Logs → `/var/log/clipdesk`, so admins can find them.
- [x] A bundled default preset file → `resource_dir()` (read), copied to `app_data_dir()` before editing.
> The executable's folder is read-only for normal users and is replaced by updates, and `/var/log` needs
> root. Cache dirs are for data that can be thrown away. Config and data dirs come from the OS (with your
> bundle identifier appended), and resources ship read-only inside the bundle.
:::

## Deep links and file associations: how the OS opens your app

Users expect "Open in ClipDesk" links on a web page and double-clicking `intro.clipdesk` to work.
Both are **registrations with the OS**, done when the app is installed or at runtime, and each OS
delivers the result differently:

```text
 user clicks clipdesk://open?clip=intro
        │
        ├─ macOS / iOS ── OS sends an "open URL" event to the RUNNING app (or launches it first)
        ├─ Android ────── an Intent starts / resumes the activity
        └─ Windows / Linux ── OS starts a NEW process:  clipdesk.exe "clipdesk://open?clip=intro"
                               └─ single-instance plugin: forward argv to the running instance, exit
```

The **deep-link plugin** (`tauri-plugin-deep-link`) hides most of this. You declare schemes in
`tauri.conf.json`:

```json
{
  "plugins": {
    "deep-link": {
      "desktop": { "schemes": ["clipdesk"] },
      "mobile": [{ "scheme": ["clipdesk"], "appLink": false }]
    }
  }
}
```

Then you read the link that launched the app (`get_current`) and listen for later ones
(`on_open_url`). On Windows and Linux you also register the **single-instance plugin with its
`deep-link` feature first**. Without it, every click starts a second ClipDesk window.

```rust
use tauri_plugin_deep_link::DeepLinkExt;

// inside .setup(|app| { ... })
if let Some(urls) = app.deep_link().get_current()? {
    handle_urls(app.handle(), urls);           // launched by a link
}
let handle = app.handle().clone();
app.deep_link().on_open_url(move |event| handle_urls(&handle, event.urls()));
```

Platform details:

- **Linux** has no installer-time registry for AppImages. Call `register_all()` at startup. An
  AppImage registers its absolute path, so moving the file breaks the link until the next start.
- **Windows** registers on install (MSI/NSIS). In development, call `register_all()` under
  `#[cfg(all(debug_assertions, windows))]`.
- **macOS** doesn't support runtime registration. Links only work for the bundled app, installed
  in `/Applications`.
- **Mobile** custom schemes work without a server. **Verified links** (`https://clipdesk.example/open/…`
  with `"appLink": true`) need a file on your domain: `assetlinks.json` (Android) or
  `apple-app-site-association` (iOS). A verified link can't be hijacked by another app that claims
  the same custom scheme.

**File associations** work the same way. `bundle.fileAssociations` in `tauri.conf.json` (`ext`,
`name`, `description`, `role`, `mimeType`) writes the registration into the installer. On
Windows/Linux the file path arrives as a command-line argument. On macOS it arrives as an "opened" event
(`RunEvent::Opened { urls }` in Tauri's run loop).

:::warn title="A deep link is untrusted input"
Any program, and any web page, can launch `clipdesk://anything`, and on Windows/Linux anyone can pass
a fake URL on the command line. Parse it strictly: check the scheme and route, require every
parameter, and validate values before they touch the file system (`clip=../../.ssh/id_ed25519`).
Never execute or `eval` anything from a link, and never let a link trigger a destructive action
without a confirmation in the UI.
:::

## Signing in: the system browser, not the webview

ClipDesk can upload clips to a cloud account. The tempting implementation is to open the identity
provider's login page *inside* a Tauri window. Don't. **RFC 8252, "OAuth 2.0 for Native Apps"**, the
current best practice, says native apps must use an **external user agent** (the system browser),
not an embedded webview:

- **The app could steal the password.** An embedded webview belongs to your app, so your code can read
  every keystroke. Users and identity providers can't tell your window from a phishing app's.
- **Providers block it.** Google, for example, refuses OAuth requests from embedded webviews
  (`Error 403: disallowed_useragent`). Others detect webview user agents too.
- **Passkeys and SSO break.** Embedded webviews often can't offer passkeys at all: the OS passkey UI
  is wired to the browser, and an embedded WKWebView or WebView2 needs extra entitlements or setup
  before WebAuthn works. The user's existing browser session, password manager and company SSO
  (smart cards, device certificates) live in the system browser, not in your webview.

### Authorization Code + PKCE, step by step

A desktop app is a **public client**: anything you ship can be extracted, so it can't keep a
client secret. PKCE (RFC 7636) replaces the secret with a **one-time secret generated per login**:

```text
 ClipDesk (Rust)                         System browser                 Identity provider
 ───────────────                         ──────────────                 ─────────────────
 1. verifier = 43–128 random chars
    challenge = BASE64URL(SHA256(verifier))
    state = random
 2. open browser ───────────────────────► GET /authorize?response_type=code
                                              &client_id=clipdesk&redirect_uri=…
                                              &code_challenge=…&code_challenge_method=S256
                                              &state=…                ─────► user logs in
                                                                              (passkey, SSO…)
 3. ◄──── redirect: clipdesk://auth/callback?code=XYZ&state=…   (deep link)
          or http://127.0.0.1:53682/callback?code=XYZ&state=…   (loopback)
 4. check state == saved state
 5. POST /token  code=XYZ & code_verifier=verifier  ─────────────────────────► hash(verifier)
                                                                              == challenge? ✔
 6. ◄────────────────────────────────────────── access token (+ refresh token)
 7. forget the verifier (one use only)
```

Why it is safe: an attacker who intercepts the **code** in step 3 (another app that registered
`clipdesk://`, or malware reading the URL) still can't exchange it, because the provider demands
the **verifier**, which never left ClipDesk. The **state** value stops a different kind of attack:
a callback your app never asked for (login CSRF).

Getting the result back into the app needs one of two **redirect** styles:

| | Custom scheme / app link (deep link) | Loopback redirect |
|---|---|---|
| Redirect URI | `clipdesk://auth/callback` or a verified `https://` app link | `http://127.0.0.1:<random port>/callback` |
| How | the deep-link plugin from the previous section | Rust binds a tiny HTTP listener on `127.0.0.1` (any free port) just for this login |
| Pros | works on mobile; no open port | no OS registration; RFC 8252 requires providers to accept any port |
| Cons | another app can claim a custom scheme (PKCE is what protects you) | desktop only; don't use `localhost` (it may resolve to IPv6 or to another host) |

Keep the token exchange and token storage **in Rust**, not in the webview. Store refresh tokens in
the OS keychain (Keychain, Windows Credential Manager, Secret Service). Open the browser with the
**opener** plugin (`tauri-plugin-opener`, `openUrl` / `open_url`).

:::pro title="What seniors do"
They use a maintained OAuth library (in Rust, for example the `oauth2` or `openidconnect` crates)
instead of hand-written token code, request the smallest scopes, and treat the callback like any
other untrusted deep link. They also test the unhappy paths: user closes the browser tab,
callback arrives twice, callback arrives after 20 minutes, provider returns `error=access_denied`.
That last list is exactly the next challenge.
:::

:::quiz id=rs-07-q6 xp=10
Why should ClipDesk sign users in through the system browser instead of a Tauri webview window?
Select all that apply.
- [x] The app can read everything typed into its own webview, so users would have to trust it with their password.
- [x] Identity providers such as Google reject OAuth from embedded webviews.
- [x] Passkeys, password managers and the existing SSO session live in the system browser.
- [ ] Webviews can't make HTTPS requests.
- [ ] The system browser makes PKCE unnecessary.
> RFC 8252 requires an external user agent for these reasons. Webviews can make HTTPS requests,
> and PKCE is still needed with the system browser, because the authorization code travels through a
> redirect that other software may observe.
:::

:::quiz id=rs-07-q7 xp=10
In the PKCE flow, what does ClipDesk send where?
- [ ] The verifier in the browser URL, the challenge in the token request.
- [x] The challenge (a hash) in the browser URL, the verifier in the token request from Rust.
- [ ] Both in the browser URL, so the provider can compare them immediately.
- [ ] A client secret compiled into the binary, plus the challenge.
> The URL that goes through the browser is visible to the user, to extensions and to whoever catches the redirect, so it
> only carries the hash. The secret verifier goes directly from the app to the token endpoint, once.
> A compiled-in client secret is not a secret.
:::

:::challenge id=rs-07-c2 lang=ts xp=60
title: A PKCE login flow as a state machine
Model ClipDesk's sign-in as a pure reducer, `reduce(state, event)`, plus a helper that builds the
authorize URL. No crypto: the caller passes in the verifier and the challenge.

```ts
type State =
  | { kind: 'idle' }
  | { kind: 'waitingForBrowser'; state: string; verifier: string; redirectUri: string; startedAt: number }
  | { kind: 'exchanging'; code: string; verifier: string }
  | { kind: 'signedIn'; accessToken: string }
  | { kind: 'failed'; reason: string }

type Event =
  | { type: 'start'; state: string; verifier: string; redirectUri: string; now: number }
  | { type: 'callback'; url: string; now: number }
  | { type: 'tokenResponse'; ok: boolean; accessToken?: string; error?: string }
  | { type: 'cancel' }
```

Rules:

1. **start** is accepted from `idle`, `failed` or `signedIn`, and is ignored (same state returned) while a login is
   in progress. The verifier must be 43–128 characters of `A–Z a–z 0–9 - . _ ~`. If it isn't, go to
   `failed` with reason `'bad_verifier'`. Otherwise go to `waitingForBrowser`.
2. **callback** only matters in `waitingForBrowser`. In any other state, return the state
   unchanged: the one-time verifier is already used, so replays do nothing. Check these in order:
   - more than 10 minutes (`600_000` ms) since `startedAt` → `failed`, `'expired'`
   - the URL without its query (`url.split('?')[0]`) differs from `redirectUri` → `failed`, `'wrong_redirect'`
   - `state` query parameter ≠ saved state → `failed`, `'state_mismatch'`
   - an `error` parameter → `failed` with that error as the reason (for example `'access_denied'`)
   - no `code` → `failed`, `'missing_code'`
   - otherwise → `exchanging` with the code and the verifier.
3. **tokenResponse** only matters in `exchanging`: `ok` with an `accessToken` → `signedIn`.
   Otherwise → `failed` with `error ?? 'token_error'`.
4. **cancel** from `waitingForBrowser` or `exchanging` → `idle`. Otherwise it is ignored.

Also write `authorizeUrl(endpoint, clientId, redirectUri, state, challenge)`. It returns `endpoint` plus the
query `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`,
`code_challenge_method=S256` and `state`, properly URL-encoded.

hint: `new URL(url).searchParams.get('state')` works for `clipdesk://…` and `http://127.0.0.1:…` URLs alike.
hint: Validate the verifier with a regex: `/^[A-Za-z0-9\-._~]{43,128}$/`.
hint: `new URLSearchParams({ ... }).toString()` does the encoding for you.
hint: Never put the verifier in the URL. Only the challenge goes there.

```ts starter
type State =
  | { kind: 'idle' }
  | { kind: 'waitingForBrowser'; state: string; verifier: string; redirectUri: string; startedAt: number }
  | { kind: 'exchanging'; code: string; verifier: string }
  | { kind: 'signedIn'; accessToken: string }
  | { kind: 'failed'; reason: string }

type Event =
  | { type: 'start'; state: string; verifier: string; redirectUri: string; now: number }
  | { type: 'callback'; url: string; now: number }
  | { type: 'tokenResponse'; ok: boolean; accessToken?: string; error?: string }
  | { type: 'cancel' }

export function authorizeUrl(endpoint: string, clientId: string, redirectUri: string, state: string, challenge: string): string {
  // TODO
  return endpoint
}

export function reduce(s: State, e: Event): State {
  switch (e.type) {
    case 'start':
      return { kind: 'waitingForBrowser', state: e.state, verifier: e.verifier, redirectUri: e.redirectUri, startedAt: e.now }
    case 'callback': {
      // TODO: validate everything; this trusts any callback
      const code = new URL(e.url).searchParams.get('code') ?? ''
      return { kind: 'exchanging', code, verifier: '' }
    }
    case 'tokenResponse':
      return e.ok ? { kind: 'signedIn', accessToken: e.accessToken ?? '' } : { kind: 'failed', reason: 'token_error' }
    case 'cancel':
      return { kind: 'idle' }
  }
}
```

```ts solution
type State =
  | { kind: 'idle' }
  | { kind: 'waitingForBrowser'; state: string; verifier: string; redirectUri: string; startedAt: number }
  | { kind: 'exchanging'; code: string; verifier: string }
  | { kind: 'signedIn'; accessToken: string }
  | { kind: 'failed'; reason: string }

type Event =
  | { type: 'start'; state: string; verifier: string; redirectUri: string; now: number }
  | { type: 'callback'; url: string; now: number }
  | { type: 'tokenResponse'; ok: boolean; accessToken?: string; error?: string }
  | { type: 'cancel' }

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
const TIMEOUT_MS = 600_000

export function authorizeUrl(endpoint: string, clientId: string, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${endpoint}?${q.toString()}`
}

export function reduce(s: State, e: Event): State {
  switch (e.type) {
    case 'start': {
      if (s.kind === 'waitingForBrowser' || s.kind === 'exchanging') return s
      if (!VERIFIER.test(e.verifier)) return { kind: 'failed', reason: 'bad_verifier' }
      return { kind: 'waitingForBrowser', state: e.state, verifier: e.verifier, redirectUri: e.redirectUri, startedAt: e.now }
    }
    case 'callback': {
      if (s.kind !== 'waitingForBrowser') return s
      if (e.now - s.startedAt > TIMEOUT_MS) return { kind: 'failed', reason: 'expired' }
      if (e.url.split('?')[0] !== s.redirectUri) return { kind: 'failed', reason: 'wrong_redirect' }
      const params = new URL(e.url).searchParams
      if (params.get('state') !== s.state) return { kind: 'failed', reason: 'state_mismatch' }
      const error = params.get('error')
      if (error) return { kind: 'failed', reason: error }
      const code = params.get('code')
      if (!code) return { kind: 'failed', reason: 'missing_code' }
      return { kind: 'exchanging', code, verifier: s.verifier }
    }
    case 'tokenResponse': {
      if (s.kind !== 'exchanging') return s
      if (e.ok && e.accessToken) return { kind: 'signedIn', accessToken: e.accessToken }
      return { kind: 'failed', reason: e.error ?? 'token_error' }
    }
    case 'cancel':
      return s.kind === 'waitingForBrowser' || s.kind === 'exchanging' ? { kind: 'idle' } : s
  }
}
```

```ts tests
const V = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' // 43 chars (RFC 7636 example)
const R = 'clipdesk://auth/callback'
const startEv = { type: 'start' as const, state: 's-123', verifier: V, redirectUri: R, now: 1000 }
const waiting = () => reduce({ kind: 'idle' }, startEv)

test('authorizeUrl carries the challenge, never the verifier', () => {
  const u = new URL(authorizeUrl('https://id.example.com/authorize', 'clipdesk', R, 's-123', 'CHAL+/='))
  expect(u.origin + u.pathname).toBe('https://id.example.com/authorize')
  expect(u.searchParams.get('response_type')).toBe('code')
  expect(u.searchParams.get('client_id')).toBe('clipdesk')
  expect(u.searchParams.get('redirect_uri')).toBe(R)
  expect(u.searchParams.get('code_challenge')).toBe('CHAL+/=')
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  expect(u.searchParams.get('state')).toBe('s-123')
})

test('start validates the verifier', () => {
  expect(waiting()).toEqual({ kind: 'waitingForBrowser', state: 's-123', verifier: V, redirectUri: R, startedAt: 1000 })
  expect(reduce({ kind: 'idle' }, { ...startEv, verifier: 'short' })).toEqual({ kind: 'failed', reason: 'bad_verifier' })
  expect(reduce({ kind: 'idle' }, { ...startEv, verifier: V.slice(0, 42) + '!' })).toEqual({ kind: 'failed', reason: 'bad_verifier' })
  expect(reduce({ kind: 'idle' }, { ...startEv, verifier: 'a'.repeat(129) })).toEqual({ kind: 'failed', reason: 'bad_verifier' })
})

test('start is ignored while a login is in progress, allowed again after failure', () => {
  const w = waiting()
  expect(reduce(w, { ...startEv, state: 'other', now: 2000 })).toBe(w)
  const failed = { kind: 'failed' as const, reason: 'expired' }
  expect(reduce(failed, startEv).kind).toBe('waitingForBrowser')
})

test('happy path: callback → exchanging → signedIn', () => {
  const ex = reduce(waiting(), { type: 'callback', url: `${R}?code=XYZ&state=s-123`, now: 5000 })
  expect(ex).toEqual({ kind: 'exchanging', code: 'XYZ', verifier: V })
  expect(reduce(ex, { type: 'tokenResponse', ok: true, accessToken: 'tok' })).toEqual({ kind: 'signedIn', accessToken: 'tok' })
})

test('loopback redirects work too', () => {
  const lb = 'http://127.0.0.1:53682/callback'
  const w = reduce({ kind: 'idle' }, { ...startEv, redirectUri: lb })
  expect(reduce(w, { type: 'callback', url: `${lb}?state=s-123&code=abc`, now: 2000 }).kind).toBe('exchanging')
})

test('callback checks, in order', () => {
  const w = waiting()
  const cb = (url: string, now = 2000) => reduce(w, { type: 'callback', url, now })
  expect(cb(`${R}?code=XYZ&state=s-123`, 1000 + 600_001)).toEqual({ kind: 'failed', reason: 'expired' })
  expect(cb(`clipdesk://evil/callback?code=XYZ&state=s-123`)).toEqual({ kind: 'failed', reason: 'wrong_redirect' })
  expect(cb(`${R}?code=XYZ&state=forged`)).toEqual({ kind: 'failed', reason: 'state_mismatch' })
  expect(cb(`${R}?code=XYZ`)).toEqual({ kind: 'failed', reason: 'state_mismatch' })
  expect(cb(`${R}?error=access_denied&state=s-123`)).toEqual({ kind: 'failed', reason: 'access_denied' })
  expect(cb(`${R}?state=s-123`)).toEqual({ kind: 'failed', reason: 'missing_code' })
})

test('a replayed callback is ignored once the verifier is used', () => {
  const ex = reduce(waiting(), { type: 'callback', url: `${R}?code=XYZ&state=s-123`, now: 2000 })
  expect(reduce(ex, { type: 'callback', url: `${R}?code=OTHER&state=s-123`, now: 2500 })).toBe(ex)
  const done = { kind: 'signedIn' as const, accessToken: 'tok' }
  expect(reduce(done, { type: 'callback', url: `${R}?code=XYZ&state=s-123`, now: 3000 })).toBe(done)
  const idle = { kind: 'idle' as const }
  expect(reduce(idle, { type: 'callback', url: `${R}?code=XYZ&state=s-123`, now: 3000 })).toBe(idle)
})

test('token errors and cancel', () => {
  const ex = { kind: 'exchanging' as const, code: 'XYZ', verifier: V }
  expect(reduce(ex, { type: 'tokenResponse', ok: false, error: 'invalid_grant' })).toEqual({ kind: 'failed', reason: 'invalid_grant' })
  expect(reduce(ex, { type: 'tokenResponse', ok: false })).toEqual({ kind: 'failed', reason: 'token_error' })
  expect(reduce(ex, { type: 'tokenResponse', ok: true })).toEqual({ kind: 'failed', reason: 'token_error' })
  const idle = { kind: 'idle' as const }
  expect(reduce(idle, { type: 'tokenResponse', ok: true, accessToken: 'x' })).toBe(idle)
  expect(reduce(waiting(), { type: 'cancel' })).toEqual({ kind: 'idle' })
  expect(reduce(ex, { type: 'cancel' })).toEqual({ kind: 'idle' })
  const done = { kind: 'signedIn' as const, accessToken: 'tok' }
  expect(reduce(done, { type: 'cancel' })).toBe(done)
})
```
:::

## Linux: the platform you'll debug most

On Windows and macOS the webview comes with the OS. On Linux, **you compile against the
distro's GTK 3 and WebKitGTK libraries**, and your users run whatever versions *their* distro has.

- **Build dependencies.** Tauri 2 needs the 4.1 API of WebKitGTK. On Debian/Ubuntu:
  `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  (Fedora: `webkit2gtk4.1-devel`; Arch: `webkit2gtk-4.1`). The appindicator package is what the
  tray icon uses. Old distros that only ship `webkit2gtk-4.0` can't build Tauri 2 apps.
- **Build on the oldest distro you support.** A binary built on a new distro links against new
  glibc and WebKitGTK symbols, and fails on older ones with `version 'GLIBC_2.39' not found`. CI
  usually builds `.deb`/`.rpm`/AppImage on an older Ubuntu LTS image.
- **Runtime differences.** Media goes through GStreamer (see above). Wayland and X11 behave
  differently for window positioning and tray icons: on GNOME, tray icons need the AppIndicator
  extension. GPU compositing bugs sometimes show up as a blank white window. The usual workaround,
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`, is a WebKitGTK environment variable. It isn't a Tauri setting.
- **Advisories you can't fix yourself.** `cargo audit` (RustSec) and `cargo deny` scan your
  `Cargo.lock`. Linux builds pull in the gtk-rs **GTK 3** bindings (`gtk`, `gdk`, `atk`, `*-sys`, …)
  through Tauri's windowing and webview crates. In 2024 RustSec flagged them as unmaintained
  (RUSTSEC-2024-0411 to -0420). You can't swap them out: the fix has to come *upstream*, in
  Tauri's own dependency chain. Those advisories were later **withdrawn** when GTK 3 binding
  development resumed. The lesson for your job: when an advisory is upstream-blocked, record
  it in an ignore list *with a reason, a link and a review date*, and re-check it. Don't silence the
  whole category.

```toml
# deny.toml (cargo-deny): an informed, documented exception
[advisories]
ignore = [
  # Example: upstream-blocked; pulled in via tauri → wry → webkit2gtk on Linux only.
  # Tracked in our issue #123; re-check on every Tauri minor upgrade.
  { id = "RUSTSEC-2024-0413", reason = "transitive via Tauri on Linux; no fix possible downstream" },
]
```

:::quiz id=rs-07-q8 xp=10
ClipDesk builds fine on your up-to-date Arch laptop. A user on an older Ubuntu LTS runs the binary
and gets `/lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not found`. What's the fix?
- [ ] Tell the user to run `cargo update`.
- [ ] Add `glibc` to `[dependencies]` in `Cargo.toml`.
- [x] Build the Linux release on the oldest distro (or container image) you support, usually in CI.
- [ ] Enable the `tray-icon` feature.
> Linux binaries link against the system's glibc and WebKitGTK. Symbols are backwards-compatible
> (old builds run on new systems) but not forwards-compatible. Building on an older base image
> produces a binary that runs on it and on everything newer.
:::

## Mobile with Tauri 2

Tauri 2 adds Android and iOS. The **same `src-tauri` crate** is compiled as a library and loaded by
a generated native project (Gradle for Android, Xcode for iOS). That's why the entry point is
`run()` in `lib.rs`, marked with `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, and why
`Cargo.toml` has `crate-type = ["staticlib", "cdylib", "rlib"]`.

```bash
# Android (Linux, macOS or Windows): Android Studio, SDK + NDK, JAVA_HOME / ANDROID_HOME / NDK_HOME set
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run tauri android init     # generates src-tauri/gen/android (commit it)
npm run tauri android dev      # runs on an emulator or a USB device, with hot reload
npm run tauri android build    # APK / AAB

# iOS (macOS only, full Xcode + CocoaPods)
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
npm run tauri ios init         # generates src-tauri/gen/apple
npm run tauri ios dev          # simulator or device
```

What changes on mobile:

- **No tray, no multiple windows, no global shortcuts.** Desktop-only plugins include the updater,
  single-instance, global-shortcut, autostart, window-state, positioner and CLI. Mobile-only ones
  include barcode scanner, biometric, haptics and NFC. Check the platform table on each plugin's
  docs page before you depend on it, then gate it with target tables and `#[cfg]` as shown above.
- **Updates go through the stores** (Play Store, App Store). The updater plugin is desktop-only.
- **Dev server address.** The device isn't your laptop, so `localhost:1420` on a phone is the
  phone. The CLI handles this by setting `TAURI_DEV_HOST`, and the template's `vite.config.ts` reads
  it. If you replaced that config, hot reload on a device stops working.
- **Capabilities can be platform-specific.** A capability file can say `"platforms": ["android", "iOS"]`
  so mobile-only permissions aren't granted on desktop (see **Tauri security: capabilities,
  permissions and plugins**).
- **Lifecycle.** The OS suspends and kills apps in the background. Save state when it happens,
  not on quit.

:::quiz id=rs-07-q9 xp=10
You want ClipDesk on iOS. Which statements are true? Select all that apply.
- [x] `tauri ios init` and `tauri ios build` need a Mac with full Xcode.
- [x] The updater plugin isn't available on iOS. Updates ship through the App Store.
- [ ] iOS uses WebView2, so the Windows CSS works unchanged.
- [x] A `#[cfg(desktop)]` tray module is simply not compiled for iOS.
- [ ] Mobile builds need a separate Rust crate with a `main()` function.
> iOS uses WKWebView (WebKit), not Chromium, so test your CSS there. The same app crate builds for
> mobile: `run()` in `lib.rs` is the entry point thanks to `cfg_attr(mobile, tauri::mobile_entry_point)`.
:::

## How it breaks in practice

| Symptom | Cause | Fix |
|---|---|---|
| `error[E0433]: cannot find module or crate tray` only in the Android build | module gated with `#[cfg(desktop)]`, call site not gated | gate the call too; build all targets in CI (`cargo check --target aarch64-linux-android`) |
| `error[E0432]: unresolved import tauri_plugin_updater` on mobile | target-scoped dependency, ungated `use` | put `use` and registration behind `#[cfg(desktop)]` |
| Desktop-only crate missing on desktop too | `[target.'cfg(desktop)'.dependencies]` | Cargo doesn't see Tauri's cfg; use `cfg(any(target_os = "macos", windows, target_os = "linux"))` |
| Clicking a link opens a **second** window (Windows/Linux) | single-instance plugin missing, or not registered first | add it with the `deep-link` feature, before other plugins |
| Deep links work in dev on Linux, not after moving the AppImage | registration stores the absolute path | call `register_all()` on every start |
| Deep links don't work on macOS in `tauri dev` | macOS has no runtime registration | test with the built `.app` in `/Applications` |
| Settings vanish after an update / "Access denied" on Windows | writing next to the `.exe` | use `app_config_dir()` / `app_data_dir()` |
| Video plays everywhere except Linux | missing GStreamer plugin | feature-detect, show install hint, or transcode |
| API calls fail with CORS on Windows only | API allows `tauri://localhost` but not `http://tauri.localhost` | allow both origins (or call the API from Rust) |
| "This browser or app may not be secure" at login | OAuth inside an embedded webview | system browser + PKCE + deep link / loopback |
| `GLIBC_2.xx not found` for Linux users | built on a newer distro | build on the oldest supported base image |
| `#[cfg(desktop)]` code never compiles in `clipdesk-core` | that crate's build script doesn't run `tauri_build` | use `target_os` cfgs in library crates |

:::lab id=rs-07-lab1 xp=120
title: ClipDesk on every desktop: tray, deep links and per-OS paths
Take a fresh Tauri 2 app and make it platform-aware. You'll add a **tray icon that only exists on desktop**
(target-scoped dependency + `#[cfg(desktop)]`), a **`clipdesk://` deep-link handler** with strict
parsing, and **per-OS paths** from the path API. Then you'll run the Rust tests and build an installer for your OS.

You need Rust stable (edition 2024; check with `rustc --version`), Node.js 20+, and the Tauri
prerequisites for your OS from v2.tauri.app → *Prerequisites*. On Linux that's the WebKitGTK 4.1
packages listed in the Linux section above. On Windows it's the C++ build tools; WebView2 is preinstalled.

**1. Create the project**

```bash
npm create tauri-app@latest -- clipdesk --template vanilla-ts --manager npm --identifier com.example.clipdesk --yes
cd clipdesk
npm install
```

**2. Dependencies, desktop-only ones in a target table.** Replace `src-tauri/Cargo.toml` with:

```toml
[package]
name = "clipdesk"
version = "0.1.0"
description = "ClipDesk, a small media-tool desktop app"
authors = ["you"]
edition = "2024"

[lib]
name = "clipdesk_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

# Every platform (desktop AND mobile)
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-deep-link = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Desktop only: Windows, macOS, Linux. Never compiled for Android/iOS.
[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }

[profile.release]
codegen-units = 1
lto = true
opt-level = 3
panic = "abort"
strip = true
```

**3. Pure platform logic with tests.** Create `src-tauri/src/platform.rs`:

```rust
//! Pure, testable platform logic: no window, no webview, no plugin needed.
use std::path::{Path, PathBuf};
use tauri::Url;

pub const SCHEME: &str = "clipdesk";

#[derive(Debug, PartialEq, Eq)]
pub enum DeepLink {
    /// clipdesk://open?clip=intro
    OpenClip { clip: String },
    /// clipdesk://auth/callback?code=...&state=...
    AuthCallback { code: String, state: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum LinkError {
    WrongScheme(String),
    UnknownRoute(String),
    MissingParam(&'static str),
    BadClipName(String),
}

/// A deep link is untrusted input: anyone can launch the app with any URL.
pub fn parse_deep_link(url: &Url) -> Result<DeepLink, LinkError> {
    if url.scheme() != SCHEME {
        return Err(LinkError::WrongScheme(url.scheme().to_string()));
    }
    // For clipdesk://auth/callback the URL parser sees host = "auth", path = "/callback".
    let route = format!("{}{}", url.host_str().unwrap_or(""), url.path());
    match route.trim_end_matches('/') {
        "open" => {
            let clip = param(url, "clip").ok_or(LinkError::MissingParam("clip"))?;
            validate_clip_name(&clip)?;
            Ok(DeepLink::OpenClip { clip })
        }
        "auth/callback" => Ok(DeepLink::AuthCallback {
            code: param(url, "code").ok_or(LinkError::MissingParam("code"))?,
            state: param(url, "state").ok_or(LinkError::MissingParam("state"))?,
        }),
        other => Err(LinkError::UnknownRoute(other.to_string())),
    }
}

fn param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .filter(|v| !v.is_empty())
}

/// Only letters, digits, '-' and '_': a clip name ends up in a file path.
pub fn validate_clip_name(name: &str) -> Result<(), LinkError> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(LinkError::BadClipName(name.to_string())) }
}

/// Paths are always built from a base dir the OS gave us, never hard-coded.
pub fn settings_file(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join("settings.json")
}

pub fn thumbnail_path(app_cache_dir: &Path, clip: &str) -> Result<PathBuf, LinkError> {
    validate_clip_name(clip)?;
    Ok(app_cache_dir.join("thumbs").join(format!("{clip}.png")))
}

pub fn os_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else if cfg!(target_os = "android") {
        "Android"
    } else if cfg!(target_os = "ios") {
        "iOS"
    } else {
        "other"
    }
}

/// `desktop` and `mobile` are cfg flags that tauri-build sets for this crate.
pub fn form_factor() -> &'static str {
    if cfg!(desktop) { "desktop" } else { "mobile" }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn parses_open_clip() {
        assert_eq!(
            parse_deep_link(&url("clipdesk://open?clip=intro-01")),
            Ok(DeepLink::OpenClip { clip: "intro-01".into() })
        );
    }

    #[test]
    fn parses_auth_callback_with_trailing_slash() {
        assert_eq!(
            parse_deep_link(&url("clipdesk://auth/callback/?code=abc&state=xyz")),
            Ok(DeepLink::AuthCallback { code: "abc".into(), state: "xyz".into() })
        );
    }

    #[test]
    fn rejects_other_schemes_and_routes() {
        assert_eq!(
            parse_deep_link(&url("https://example.com/open?clip=intro")),
            Err(LinkError::WrongScheme("https".into()))
        );
        assert_eq!(
            parse_deep_link(&url("clipdesk://delete?clip=intro")),
            Err(LinkError::UnknownRoute("delete".into()))
        );
        assert_eq!(
            parse_deep_link(&url("clipdesk://auth/callback?code=abc")),
            Err(LinkError::MissingParam("state"))
        );
    }

    #[test]
    fn rejects_path_traversal_in_clip_names() {
        assert_eq!(
            parse_deep_link(&url("clipdesk://open?clip=..%2F..%2Fsecrets")),
            Err(LinkError::BadClipName("../../secrets".into()))
        );
        assert!(thumbnail_path(Path::new("/cache"), "a/b").is_err());
    }

    #[test]
    fn builds_paths_from_the_base_dir() {
        let base = Path::new("base");
        assert_eq!(settings_file(base), base.join("settings.json"));
        assert_eq!(
            thumbnail_path(base, "intro").unwrap(),
            base.join("thumbs").join("intro.png")
        );
    }

    #[test]
    fn knows_where_it_was_compiled() {
        assert_eq!(form_factor(), "desktop");
        let expected = match std::env::consts::OS {
            "windows" => "Windows",
            "macos" => "macOS",
            "linux" => "Linux",
            _ => "other",
        };
        assert_eq!(os_label(), expected);
    }
}
```

`tauri::Url` is the `url` crate's `Url`, re-exported by Tauri. The deep-link plugin hands you
values of exactly this type, so you don't need an extra dependency.

**4. The desktop-only tray.** Create `src-tauri/src/tray.rs`:

```rust
//! Desktop only: this whole module is compiled out on Android and iOS.
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};

pub fn create(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show ClipDesk", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("ClipDesk")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
```

**5. Wire it up.** Replace `src-tauri/src/lib.rs`:

```rust
mod platform;
#[cfg(desktop)]
mod tray;

use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

fn handle_urls(app: &AppHandle, urls: Vec<Url>) {
    for url in urls {
        match platform::parse_deep_link(&url) {
            Ok(link) => {
                println!("[clipdesk] deep link: {link:?}");
                let _ = app.emit("deep-link", format!("{link:?}"));
            }
            Err(e) => eprintln!("[clipdesk] ignored deep link {url}: {e:?}"),
        }
    }
}

#[tauri::command]
fn platform_info(app: AppHandle) -> Result<String, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let thumb = platform::thumbnail_path(&cache, "intro").map_err(|e| format!("{e:?}"))?;
    Ok(format!(
        "{} ({}) | data: {} | thumbnails: {}",
        platform::os_label(),
        platform::form_factor(),
        data.display(),
        thumb.display()
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be the FIRST plugin. With its "deep-link" feature, a second launch
    // (e.g. from a clicked link on Windows/Linux) forwards the URL to this instance.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            tray::create(app)?;

            // Linux always, Windows in dev: write the scheme registration ourselves.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let settings = platform::settings_file(&config_dir);
            if !settings.exists() {
                std::fs::write(&settings, "{ \"theme\": \"system\" }\n")?;
            }
            println!(
                "[clipdesk] {} ({}), settings: {}",
                platform::os_label(),
                platform::form_factor(),
                settings.display()
            );

            if let Some(urls) = app.deep_link().get_current()? {
                handle_urls(app.handle(), urls);
            }
            let handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| handle_urls(&handle, event.urls()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![platform_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**6. Config and permissions.** In `src-tauri/tauri.conf.json`, set `"productName": "ClipDesk"` and
add a top-level `plugins` key (next to `app` and `bundle`):

```json
"plugins": {
  "deep-link": {
    "desktop": { "schemes": ["clipdesk"] },
    "mobile": [{ "scheme": ["clipdesk"], "appLink": false }]
  }
}
```

In `src-tauri/capabilities/default.json`, add `"deep-link:default"` to `permissions`, so the list is
`["core:default", "opener:default", "deep-link:default"]`.

**7. A tiny frontend.** Replace `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="stylesheet" href="/src/styles.css" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ClipDesk</title>
    <script type="module" src="/src/main.ts" defer></script>
  </head>
  <body>
    <main class="container">
      <h1>ClipDesk</h1>
      <p id="platform">Loading platform info...</p>
      <h2>Deep links received</h2>
      <ul id="links"></ul>
    </main>
  </body>
</html>
```

and `src/main.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

window.addEventListener("DOMContentLoaded", async () => {
  const platformEl = document.querySelector<HTMLElement>("#platform")!;
  const linksEl = document.querySelector<HTMLUListElement>("#links")!;

  platformEl.textContent = await invoke<string>("platform_info");

  await listen<string>("deep-link", (event) => {
    const li = document.createElement("li");
    li.textContent = event.payload; // textContent, never innerHTML: the link is untrusted
    linksEl.append(li);
  });
});
```

**8. Run the tests**

```bash
cd src-tauri
cargo test
cd ..
```

Expected (after the first, slower compile):

```text
running 6 tests
test platform::tests::builds_paths_from_the_base_dir ... ok
test platform::tests::knows_where_it_was_compiled ... ok
test platform::tests::parses_auth_callback_with_trailing_slash ... ok
test platform::tests::parses_open_clip ... ok
test platform::tests::rejects_other_schemes_and_routes ... ok
test platform::tests::rejects_path_traversal_in_clip_names ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

(The order of the lines can vary: tests run in parallel.)

**9. Run it and fire a deep link**

```bash
npm run tauri dev
```

The terminal prints a line like `[clipdesk] Linux (desktop), settings: /home/you/.config/com.example.clipdesk/settings.json`
(macOS: `~/Library/Application Support/com.example.clipdesk/…`, Windows:
`C:\Users\you\AppData\Roaming\com.example.clipdesk\…`). The window shows the data and thumbnail
paths, and a ClipDesk icon appears in the tray. Click it (by default the menu opens on left and right click) for **Show ClipDesk** / **Quit**.

With the app running, open a second terminal:

```bash
# Linux
xdg-open 'clipdesk://open?clip=intro'
xdg-open 'clipdesk://open?clip=..%2Fsecrets'
# Windows (PowerShell or cmd)
start clipdesk://open?clip=intro
```

The first link appears in the window as `OpenClip { clip: "intro" }`, and **no second window
opens** (single-instance). The second prints `ignored deep link … BadClipName("../secrets")` in
the first terminal.

:::info
**macOS:** deep links only work for the bundled app, because macOS has no runtime registration. Do step 10 first,
drag `ClipDesk.app` to `/Applications`, start it once, then run `open 'clipdesk://open?clip=intro'`.
**GNOME:** if no tray icon shows up, install/enable the *AppIndicator and KStatusNotifierItem
Support* extension.
:::

**10. Build for your OS**

```bash
npm run tauri build
```

The bundles land in `src-tauri/target/release/bundle/`: `deb/`, `rpm/` and `appimage/` on Linux, `macos/`
(`ClipDesk.app`) and `dmg/` on macOS, `msi/` and `nsis/` on Windows. To build just one format, pass
it through, e.g. `npm run tauri build -- --bundles deb`. (Signing and CI are covered in **Shipping:
bundles, signing, auto-update and CI**.)

**11. Break it on purpose** (then undo each change)

- Remove `#[cfg(desktop)]` from the `tray::create(app)?;` line and run
  `cargo check --target aarch64-linux-android` in `src-tauri` (after
  `rustup target add aarch64-linux-android`; it may also fail earlier for lack of an Android NDK. If so,
  read the reasoning, and remember this is exactly why CI checks every target).
- Change the target table to `[target.'cfg(desktop)'.dependencies]` and run `cargo check`, on desktop: you get
  `error[E0432]: unresolved import tauri::tray` (the `tray-icon` feature was never enabled) and
  `error[E0433]: cannot find module or crate tauri_plugin_single_instance`. Cargo never saw `desktop`.
- Change `validate_clip_name` to always return `Ok(())`: `cargo test` fails
  `rejects_path_traversal_in_clip_names`.

- [ ] `cargo test` in `src-tauri` reports 6 passed
- [ ] `npm run tauri dev` prints the settings path for your OS, and `settings.json` exists there
- [ ] The tray icon shows; **Quit** in its menu exits the app
- [ ] A `clipdesk://open?clip=intro` link reaches the running app without opening a second window, and the `../` link is rejected
- [ ] `npm run tauri build` produced an installer/bundle for your OS
- [ ] You broke the `cfg(desktop)` target table on purpose and saw why Cargo can't use it
:::

:::cards id=rs-07-cards1 xp=15 title="Cross-platform Tauri"
Q: Which webview does Tauri use on each platform?
A: Windows: WebView2 (Chromium). macOS and iOS: WKWebView (WebKit). Linux: WebKitGTK.
   Android: System WebView (Chromium). None is bundled with your app.
Q: `#[cfg(x)]` vs `cfg!(x)`?
A: The attribute removes the item before type checking. `cfg!` becomes `true`/`false`, and both branches must still compile.
Q: What do `all()`, `any()` and an unknown cfg name evaluate to?
A: `all()` is true, `any()` is false, and an unknown name is false (with an `unexpected_cfgs` warning in recent Rust).
Q: Where do `cfg(desktop)` and `cfg(mobile)` come from?
A: The `tauri_build::build()` build script emits them for your app crate. They aren't built-in, and Cargo target tables can't see them.
Q: How do you add a dependency only on desktop?
A: `[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]`, or
   `cargo add <crate> --target '<that cfg>'`. Then gate the `use` and the code with `#[cfg(desktop)]`.
Q: Where do settings, user data, cache and logs go?
A: `app_config_dir`, `app_data_dir`, `app_cache_dir`, `app_log_dir` from the path API (they include the
   bundle identifier). Never next to the executable.
Q: Why does Windows/Linux need the single-instance plugin for deep links?
A: The OS starts a new process with the URL in argv. The plugin forwards it to the running instance.
Q: Why not log in inside the webview?
A: The app could read the password, providers block embedded webviews, and passkeys/SSO live in the system browser (RFC 8252).
Q: What do PKCE's verifier and challenge do?
A: The challenge (a SHA-256 hash) goes in the browser URL. The verifier goes only in the token request, so a stolen code is useless.
Q: What is `state` for in OAuth?
A: A random value checked on the callback, so the app rejects callbacks it didn't start (login CSRF).
Q: Why build Linux releases on an old distro?
A: glibc/WebKitGTK symbols are backwards- but not forwards-compatible.
Q: Commands to start a Tauri 2 mobile project?
A: `tauri android init` / `tauri android dev`, and `tauri ios init` / `tauri ios dev` (macOS + Xcode only).
:::

## Recap

- One frontend, **five webviews**: WebView2 and Android WebView are Chromium; macOS, iOS and Linux are
  WebKit, each with its own versioning. Feature-detect web features and **codecs**. Linux media
  depends on GStreamer, and the app origin differs (`http://tauri.localhost` vs `tauri://localhost`).
- `#[cfg(...)]` **removes code** per target. `cfg!()` only yields a bool, so both branches must compile.
  `all`/`any`/`not`, `target_os`, `target_family`, `unix`/`windows`, `feature`, and unknown = false.
- Tauri's build script adds **`desktop` / `mobile`** for the app crate only. Cargo's
  `[target.'cfg(...)'.dependencies]` sees only built-in cfgs, so desktop-only crates (tray feature,
  updater, single-instance) use `cfg(any(target_os = "macos", windows, target_os = "linux"))`.
  Gate the dependency and its code together.
- **Paths** come from the path API (`app_config_dir`, `app_data_dir`, `app_cache_dir`, `app_log_dir`).
  Join paths, don't concatenate them, and never write next to the executable.
- **Deep links and file associations** are OS registrations. Windows/Linux deliver them as argv (so
  use single-instance), macOS/iOS as events. Every link is **untrusted input**.
- **Sign in through the system browser** with Authorization Code + **PKCE** and `state`, and receive the code via
  deep link or loopback redirect (RFC 8252). Embedded-webview logins are unsafe and often blocked.
- **Linux**: build against WebKitGTK 4.1 on the oldest distro you support. Handle upstream-blocked
  advisories with documented, reviewed exceptions.
- **Mobile**: `tauri android|ios init/dev/build`, the same crate via `mobile_entry_point`, no tray,
  updater or single-instance, and store-based updates.
