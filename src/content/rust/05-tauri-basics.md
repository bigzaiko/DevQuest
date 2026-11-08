---
id: rs-05
title: "Tauri 2: a desktop app with a web frontend"
level: intermediate
minutes: 110
xp: 150
summary: How Tauri 2 pairs a system webview with a Rust core, how the frontend calls Rust commands with invoke(), and how events, managed state and windows fit together. You build a small React + Rust desktop app.
---

You can already write a React frontend, and the first four lessons of Crab Forge gave you enough
Rust to be dangerous: ownership (**Ownership, borrowing and lifetimes**), `Result` and `serde`
(**Traits, generics, errors and crates**), and `async`/`Mutex` (**Concurrency and async: threads,
channels, tokio**). **Tauri** joins the two. The UI is a normal web app (Vite + React), and the
part that touches the machine (files, processes, encoders, the OS) is a Rust binary. They talk over
a small, typed message bridge.

Throughout the lesson we build **ClipDesk**, a small desktop tool for media clips. It shows
information about the machine it runs on, "exports" a clip while reporting progress, and counts
exports in shared state.

:::info title="Words you'll meet in this lesson"
- **Webview**: a browser engine embedded in a native window. It renders HTML/CSS/JS but has no
  address bar or tabs.
- **System webview**: the webview the OS already ships. That is **WebView2** (Chromium-based) on
  Windows, **WKWebView** (WebKit) on macOS and iOS, **WebKitGTK** on Linux, and the Android **System WebView**.
- **IPC** (inter-process communication): the messages between the webview (JavaScript) and the
  Rust core. In Tauri the main ones are **commands** (request/response) and **events** (fire-and-forget).
- **Command**: a Rust function marked `#[tauri::command]` that JavaScript calls with `invoke()`.
- **serde**: the Rust serialization library. It turns Rust structs into JSON and back. Every value
  that crosses the bridge goes through it.
- **Capability**: a JSON file that says which permissions a window has. It gets one section here;
  **Tauri security: capabilities, permissions and plugins** covers it in depth.
:::

## Why Tauri? The system webview bet

Desktop apps built with web technology have been the norm since **Electron** (VS Code, Slack,
Discord). Electron's design is simple: every app **ships its own Chromium and its own Node.js**.
That is predictable (the same engine on every OS), but each app is large (an installer is often
around 100 MB), each app runs a full browser, and the "backend" is Node with full OS access.

Tauri makes a different bet:

```text
            Electron                                Tauri 2
 ┌─────────────────────────────┐       ┌─────────────────────────────┐
 │ your app                    │       │ your app                    │
 │  ┌───────────┐ ┌──────────┐ │       │  ┌───────────┐ ┌──────────┐ │
 │  │ Chromium  │ │ Node.js  │ │       │  │ your HTML │ │ Rust core│ │
 │  │ (bundled) │ │ (bundled)│ │       │  │ JS / CSS  │ │ (native  │ │
 │  │ + your JS │ │ + your JS│ │       │  │           │ │  binary) │ │
 │  └───────────┘ └──────────┘ │       │  └─────┬─────┘ └────▲─────┘ │
 └─────────────────────────────┘       │        │ invoke /    │       │
   installer: often ~100 MB            │        │ events      │       │
                                       │  ┌─────▼────────────┴─────┐ │
                                       │  │ OS webview (WebView2,  │ │
                                       │  │ WKWebView, WebKitGTK)  │ │
                                       │  └────────────────────────┘ │
                                       └─────────────────────────────┘
                                         installer: a few MB
```

- **Small binaries.** The browser engine is already on the user's machine, so the app ships only
  your frontend assets and one compiled Rust binary. A minimal app can be a few megabytes.
- **Usually less memory.** No bundled browser and no Node runtime per app (the system webview still
  runs its own processes).
- **Rust for the privileged side.** Code that reads files or runs processes is compiled, memory-safe
  Rust, and the frontend can reach only the commands and permissions you expose. (That is the
  subject of **Tauri security: capabilities, permissions and plugins**.)
- **Mobile too.** Tauri 2 targets Android and iOS from the same project (see **One app, every
  platform: Windows, macOS, Linux, Android, iOS**).

The cost: **the webview differs per OS.** Your CSS and JS run on Chromium (Windows), WebKit (macOS)
and WebKitGTK (Linux). You test on all of them, the way you would test a website in Chrome and Safari.

:::job title="What you'll see at work"
Teams pick Tauri when install size, memory or a Rust backend matters: tools that ship to many
machines, apps that wrap a native library (media, crypto, hardware), or companion apps for a web
product. A typical first task is "add a command that does X and show it in the UI", which is
exactly what this lesson teaches. Expect a React/Vite frontend that the web team can also work on, and
a `src-tauri/` folder the Rust people own.
:::

:::quiz id=rs-05-q1 xp=10
Why is a Tauri app's installer usually much smaller than an Electron app's?
- [ ] Tauri compresses JavaScript into WebAssembly.
- [x] Tauri uses the webview the OS already ships instead of bundling a browser engine and Node.js.
- [ ] Tauri downloads the frontend from a server on first launch.
- [ ] Rust binaries are always smaller than JavaScript files.
> Electron ships Chromium and Node inside every app. Tauri renders with the system webview (WebView2,
> WKWebView, WebKitGTK), so the bundle holds only your assets and one Rust binary. The trade-off is that
> you test on several browser engines.
:::

## Creating a project and finding your way around

The official scaffolder asks a few questions (name, frontend language, package manager, template):

```bash
npm create tauri-app@latest
# or non-interactive:
npm create tauri-app@latest clipdesk -- --template react-ts --manager npm --identifier com.example.clipdesk --yes
cd clipdesk
npm install
npm run tauri dev      # starts Vite, compiles Rust, opens the window
npm run tauri build    # release build + installers for this OS
```

The result is two projects in one folder: a **Vite + React** app at the top and a **Cargo** project
in `src-tauri/`:

```text
clipdesk/
├── package.json            ← npm scripts; deps: react, @tauri-apps/api, @tauri-apps/cli
├── vite.config.ts          ← fixed port 1420, strictPort (the Rust side expects it)
├── index.html
├── src/                    ← the frontend (React)
│   ├── main.tsx
│   └── App.tsx
└── src-tauri/              ← the Rust core (a normal Cargo project)
    ├── Cargo.toml          ← crates: tauri, serde, serde_json, plugins
    ├── build.rs            ← tauri_build::build(): generates schemas, embeds config
    ├── tauri.conf.json     ← app name, identifier, windows, dev URL, bundle settings
    ├── capabilities/
    │   └── default.json    ← which permissions the "main" window gets
    ├── icons/
    └── src/
        ├── main.rs         ← desktop entry point: calls clipdesk_lib::run()
        └── lib.rs          ← your code: commands, setup, state, run()
```

`tauri.conf.json` connects the two halves:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "clipdesk",
  "version": "0.1.0",
  "identifier": "com.example.clipdesk",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{ "title": "clipdesk", "width": 800, "height": 600 }],
    "security": { "csp": null }
  }
}
```

- In **dev**, `tauri dev` runs `beforeDevCommand` (Vite), and the webview loads `devUrl`, so you get
  hot reload for the frontend. When you save a `.rs` file, the CLI recompiles and restarts the app.
- In **build**, `beforeBuildCommand` produces `dist/`, which is **embedded into the binary**. The
  release app needs no web server and no network.
- `identifier` (reverse domain) names the app for the OS: data folders, bundle IDs, the registry.
  Choose it once. Changing it later makes the OS treat the app as a different one.

:::warn title="Tauri 1 tutorials are everywhere"
Most blog posts and answers online are for Tauri 1. Signs that something is outdated:
`"allowlist"` in `tauri.conf.json` (replaced by capabilities), `import { invoke } from
'@tauri-apps/api/tauri'` (now `@tauri-apps/api/core`), `"distDir"`/`"devPath"` (now `frontendDist`/`devUrl`),
and `Window`/`get_window` for the app window (now `WebviewWindow`/`get_webview_window`; the old names
still exist behind the `unstable` feature but mean a window without its webview). Prefer the v2 docs at v2.tauri.app.
:::

### Why `main.rs` *and* `lib.rs`?

The template splits the Rust entry point in two:

```rust
// src-tauri/src/main.rs
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    clipdesk_lib::run()
}
```

```rust
// src-tauri/src/lib.rs
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

On desktop, the OS starts an **executable**, and `main()` simply calls `run()`. On Android and
iOS there is no `main()` you control. The platform's own app shell (Kotlin/Swift) loads your Rust code as a
**library** and calls an exported entry point. `#[cfg_attr(mobile, tauri::mobile_entry_point)]`
generates that export only for mobile builds. This is why `Cargo.toml` has:

```toml
[lib]
name = "clipdesk_lib"                         # distinct from the bin name (a Windows quirk)
crate-type = ["staticlib", "cdylib", "rlib"]  # iOS static lib, Android shared lib, rlib for main.rs
```

**Put your code in `lib.rs` (and its modules), and leave `main.rs` alone.** Then one codebase serves
every platform.

`generate_context!()` reads `tauri.conf.json` **at compile time** and embeds the config, icons and
(in release) the frontend assets. A typo in the config is therefore a *compile* error.

:::quiz id=rs-05-q2 xp=10
A teammate moves all commands and `tauri::Builder` into `main.rs` and deletes `lib.rs`. Desktop
builds still work. What breaks?
- [ ] Nothing. `main.rs` and `lib.rs` are interchangeable.
- [ ] Hot reload in `tauri dev`.
- [x] Android and iOS builds, which load the app as a library through the entry point that `mobile_entry_point` generates.
- [ ] `invoke()`, which can only call functions defined in `lib.rs` for security reasons.
> Mobile platforms do not run a Rust `main()`. They load a library (`cdylib`/`staticlib`) and call the
> function exported by `#[cfg_attr(mobile, tauri::mobile_entry_point)]`. Keeping the code in `lib.rs`
> with a tiny `main.rs` lets desktop and mobile share one `run()`.
:::

## Commands: calling Rust from JavaScript

A **command** is a Rust function with `#[tauri::command]`, registered with `generate_handler!`:

```rust
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]            // cpu_count → "cpuCount" in JSON
struct SystemInfo {
    os: String,
    cpu_count: usize,
}

#[tauri::command]
fn system_info() -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        cpu_count: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
    }
}

#[tauri::command]
fn rename_clip(clip_id: u32, new_name: String) -> String {
    format!("clip {clip_id} is now {new_name}")
}

// in run():
// .invoke_handler(tauri::generate_handler![system_info, rename_clip])
```

```ts
import { invoke } from '@tauri-apps/api/core'

type SystemInfo = { os: string; cpuCount: number }

const info = await invoke<SystemInfo>('system_info')
const msg = await invoke<string>('rename_clip', { clipId: 7, newName: 'intro' })
```

What happens on each call:

```text
 JS: invoke('rename_clip', { clipId: 7, newName: 'intro' })
   │  1. args object → JSON
   ▼
 Tauri IPC ──► find "rename_clip" in the handler list   (missing → reject "Command rename_clip not found")
   │  2. for each Rust parameter: snake_case name → camelCase key
   │     clip_id ← args.clipId,  new_name ← args.newName  (missing → reject "... missing required key clipId")
   │  3. serde::Deserialize each value into the Rust type   (wrong type → reject)
   ▼
 Rust: rename_clip(7, "intro".to_string())
   │  4. return value → serde::Serialize → JSON
   ▼
 JS: Promise resolves with "clip 7 is now intro"
```

Rules to remember:

- **Names.** The command name is the Rust function name (`'rename_clip'`). Argument keys are the
  parameter names converted to **camelCase** (`clip_id` → `clipId`). To use snake_case keys in JS
  instead, write `#[tauri::command(rename_all = "snake_case")]`.
- **Optional parameters.** A missing key is an error, except for an `Option<T>` parameter: an absent
  key (or `null`) becomes `None`.
- **Types.** Parameters must implement `serde::Deserialize`, return values `serde::Serialize`. The
  return type gets its own `rename_all` if you want camelCase fields, since struct fields are not renamed
  automatically.
- **Register them all in one `generate_handler![a, b, c]`.** Calling `.invoke_handler()` twice keeps
  only the last one.
- Commands defined directly in `lib.rs` must **not** be `pub` (a limitation of the generated glue
  code). Commands in a module (`mod commands;`) are `pub fn` and registered as `commands::name`. JS
  still calls them as `'name'`.
- `invoke` returns a **Promise**, even for a synchronous Rust function. The call crosses a process
  boundary.

:::quiz id=rs-05-q3 xp=10
Rust: `fn export_clip(clip_name: String, steps: u32) -> String`, registered correctly.
JS: `await invoke('export_clip', { clip_name: 'intro', steps: 3 })`. What happens?
- [ ] It works: Tauri accepts both spellings.
- [ ] Compile error in Rust: parameter names must be camelCase.
- [x] The promise rejects with an "invalid args `clipName` ... missing required key clipName" error.
- [ ] `clip_name` arrives as an empty string.
> By default Tauri looks up each Rust parameter under its **camelCase** key. `clip_name` is looked up
> as `clipName`, which is not in the object, so the call is rejected before your function runs. Send
> `{ clipName: 'intro', steps: 3 }`, or opt into `rename_all = "snake_case"` on the command.
:::

### Errors: return a `Result`

A command that can fail returns `Result<T, E>`. `Ok(v)` resolves the promise with `v`; `Err(e)`
**rejects** it with the serialized `e`. The error type must implement `Serialize` too. The common
pattern combines `thiserror` (for `Display`) with a hand-written `Serialize` that sends the message:

```rust
#[derive(Debug, thiserror::Error)]
enum ExportError {
    #[error("clip name must not be empty")]
    EmptyName,
    #[error("steps must be between 1 and 100, got {0}")]
    InvalidSteps(u32),
    #[error(transparent)]
    Io(#[from] std::io::Error),            // lets `?` convert io errors
}

impl serde::Serialize for ExportError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())   // the frontend receives the Display text
    }
}

#[tauri::command]
fn probe_clip(path: String) -> Result<u64, ExportError> {
    let meta = std::fs::metadata(&path)?;  // io::Error → ExportError::Io via #[from]
    Ok(meta.len())
}
```

```ts
try {
  const bytes = await invoke<number>('probe_clip', { path })
} catch (err) {
  // err is whatever the Err serialized to, here a string, NOT an Error object
  showToast(String(err))
}
```

For a quick prototype, `.map_err(|e| e.to_string())` with `Result<T, String>` works too. If the
frontend needs to branch on the error kind, derive `Serialize` with
`#[serde(tag = "kind", content = "message")]` and the frontend receives `{ kind, message }`.

:::pro title="Never panic in a command"
`unwrap()` on user input inside a command does not return an error to the UI. In an async command
the panic kills that task and the promise never settles. A sync command runs on the main thread,
where a panic can take the whole app down. Many teams also set `panic = "abort"` in
`[profile.release]` (the Tauri "App size" guide suggests it), and then any panic exits the app.
Seniors treat each command as an API endpoint: validate the input, return `Result`, and keep
`unwrap()` for invariants that truly cannot fail.
:::

### Async commands

A plain `fn` command runs on the **main thread**. Put a slow job there (hashing a 2 GB file, waiting on
a socket) and the window freezes, because the main thread also runs the event loop. Mark it `async` and Tauri runs it on
its async runtime (tokio) instead:

```rust
#[tauri::command]
async fn fetch_thumbnail(clip_id: u32) -> Result<Vec<u8>, String> {
    tokio::time::sleep(std::time::Duration::from_millis(200)).await; // stands in for real I/O
    Ok(vec![0; 16])
}
```

Two rules from the compiler that catch everyone:

1. **Async commands with borrowed parameters (`&str`, `State<'_, T>`) must return a `Result`.**
   If you write `async fn f(name: &str) -> String`, the build fails with
   `error[E0277]: async commands that contain references as inputs must return a Result`.
   Fix it by taking `String` instead of `&str`, or by returning `Result<_, _>`.
2. **The future must be `Send`.** Tauri may run it on any worker thread. Holding a
   `std::sync::MutexGuard` across an `.await` fails with *"future cannot be sent between threads
   safely … `Send` is not implemented for `std::sync::MutexGuard`"*. Lock, copy or update, and let the guard drop **before** the next `.await`.

:::quiz id=rs-05-q4 xp=15
Will this compile?

```rust
#[tauri::command]
async fn tag_clip(name: &str, tag: String) -> String {
    format!("{name} #{tag}")
}
```
- [ ] Yes. `&str` is fine because Tauri keeps the JSON alive until the future finishes.
- [x] No: `error[E0277]: async commands that contain references as inputs must return a Result`.
- [ ] No: `error[E0106]: missing lifetime specifier`.
- [ ] It compiles but panics at runtime when called.
> Tauri's macro rejects async commands that borrow input unless they return a `Result` (a known
> limitation, tracked upstream). Either change `name: &str` to `name: String`, or return
> `Result<String, String>`. Sync commands may take `&str` freely, as the template's `greet` does.
:::

## Model it: the IPC bridge in TypeScript

The browser in this lesson cannot run Rust, but the bridge's *rules* are plain data
transformations. Model them, and you will recognize every IPC error message you meet later.

:::challenge id=rs-05-c1 lang=ts xp=40
title: Map JS arguments to Rust parameters
Tauri maps each Rust parameter name (snake_case) to a JS key (camelCase) and rejects calls with a
missing key. Implement:

- `snakeToCamel(name)`: `"clip_name"` → `"clipName"`, `"x"` → `"x"`, `"max_bit_rate"` → `"maxBitRate"`.
- `bindArgs(command, params, args, renameAll)`: returns an object keyed by the **Rust** parameter
  names. `params` lists the Rust names in order. With `renameAll` `"camelCase"` (the default),
  each parameter is read from `args[snakeToCamel(p)]`. With `"snake_case"`, it is read from `args[p]`.
  If a key is absent (`undefined`), throw an `Error` with the exact message
  ``invalid args `KEY` for command `COMMAND`: command COMMAND missing required key KEY``, where KEY is the JS key you looked for.
  Extra keys in `args` are ignored. `null` is a value (it maps to Rust `Option::None`), not a missing key.
  (Real Tauri also accepts an absent key for an `Option<T>` parameter. This model treats every parameter as required.)

hint: `name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())`
hint: Build the JS key first (`renameAll === 'snake_case' ? p : snakeToCamel(p)`), then check `args[key] === undefined`.

```ts starter
export function snakeToCamel(name: string): string {
  return name
}

export function bindArgs(
  command: string,
  params: string[],
  args: Record<string, unknown>,
  renameAll: 'camelCase' | 'snake_case' = 'camelCase',
): Record<string, unknown> {
  return args
}
```

```ts solution
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

export function bindArgs(
  command: string,
  params: string[],
  args: Record<string, unknown>,
  renameAll: 'camelCase' | 'snake_case' = 'camelCase',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of params) {
    const key = renameAll === 'snake_case' ? p : snakeToCamel(p)
    if (args[key] === undefined) {
      throw new Error(`invalid args \`${key}\` for command \`${command}\`: command ${command} missing required key ${key}`)
    }
    out[p] = args[key]
  }
  return out
}
```

```ts tests
test('snakeToCamel converts each underscore + letter', () => {
  expect(snakeToCamel('clip_name')).toBe('clipName')
  expect(snakeToCamel('max_bit_rate')).toBe('maxBitRate')
  expect(snakeToCamel('x')).toBe('x')
  expect(snakeToCamel('track_2')).toBe('track2')
})
test('binds camelCase JS keys to snake_case Rust params', () => {
  expect(bindArgs('export_clip', ['clip_name', 'steps'], { clipName: 'intro', steps: 3 }))
    .toEqual({ clip_name: 'intro', steps: 3 })
})
test('ignores extra keys', () => {
  expect(bindArgs('rename_clip', ['clip_id'], { clipId: 7, extra: true })).toEqual({ clip_id: 7 })
})
test('snake_case JS keys are rejected by default', () => {
  expect(() => bindArgs('export_clip', ['clip_name', 'steps'], { clip_name: 'intro', steps: 3 }))
    .toThrow('invalid args `clipName` for command `export_clip`: command export_clip missing required key clipName')
})
test('rename_all = "snake_case" reads snake_case keys', () => {
  expect(bindArgs('export_clip', ['clip_name'], { clip_name: 'intro' }, 'snake_case'))
    .toEqual({ clip_name: 'intro' })
  expect(() => bindArgs('export_clip', ['clip_name'], { clipName: 'intro' }, 'snake_case'))
    .toThrow('missing required key clip_name')
})
test('null is a value, not a missing key', () => {
  expect(bindArgs('set_cover', ['cover_path'], { coverPath: null })).toEqual({ cover_path: null })
})
test('a command without params needs no args', () => {
  expect(bindArgs('system_info', [], {})).toEqual({})
})
```
:::

The second piece is the registry and `invoke` itself. A Rust `Result` is modelled as
`{ ok: true, value }` or `{ ok: false, error }`, and JSON serialization is modelled with
`JSON.parse(JSON.stringify(...))`. That is why a `Date` reaches Rust as a string and a `Map` as `{}`.

:::challenge id=rs-05-c2 lang=ts xp=50
title: A tiny IPC bridge
Implement `createBridge()`, which returns `{ register, invoke }`:

- `register(name, params, handler)`: stores a command. `params` are the Rust (snake_case) parameter
  names. `handler(args)` receives an object keyed by those names and returns a `RustResult` (or a
  `Promise` of one, for async commands). Registering a name twice throws
  `Error("command NAME already registered")`.
- `invoke(name, args = {})`: returns a `Promise` that
  1. rejects with the **string** `"Command NAME not found"` for an unknown command,
  2. rejects with the **string** message of the `bindArgs` error if a key is missing (`bindArgs` and
     `snakeToCamel` are provided in the setup, camelCase mode),
  3. passes the handler arguments that went through a JSON round trip (`JSON.parse(JSON.stringify(...))`),
  4. resolves with the JSON round trip of `value` for `{ ok: true }`, or rejects with the JSON round
     trip of `error` for `{ ok: false }`. A `value` of `undefined` (Rust `()`) resolves to `null`.

hint: Start with `return new Promise(...)`, or make `invoke` an `async` function: `throw` inside an async function rejects the promise.
hint: `const roundTrip = (v: unknown) => v === undefined ? null : JSON.parse(JSON.stringify(v))`
hint: In the missing-key case, reject with `(e as Error).message`, not the Error object. Tauri sends strings.

```ts setup
type RustResult = { ok: true; value?: unknown } | { ok: false; error: unknown }
type Handler = (args: Record<string, unknown>) => RustResult | Promise<RustResult>

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}
function bindArgs(command: string, params: string[], args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of params) {
    const key = snakeToCamel(p)
    if (args[key] === undefined) {
      throw new Error(`invalid args \`${key}\` for command \`${command}\`: command ${command} missing required key ${key}`)
    }
    out[p] = args[key]
  }
  return out
}
```

```ts starter
export function createBridge() {
  function register(name: string, params: string[], handler: Handler): void {
    // store the command
  }
  function invoke(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return Promise.resolve(undefined)
  }
  return { register, invoke }
}
```

```ts solution
export function createBridge() {
  const commands = new Map<string, { params: string[]; handler: Handler }>()
  const roundTrip = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)))

  function register(name: string, params: string[], handler: Handler): void {
    if (commands.has(name)) throw new Error(`command ${name} already registered`)
    commands.set(name, { params, handler })
  }

  async function invoke(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const cmd = commands.get(name)
    if (!cmd) throw `Command ${name} not found`
    let bound: Record<string, unknown>
    try {
      bound = bindArgs(name, cmd.params, roundTrip(args))
    } catch (e) {
      throw (e as Error).message
    }
    const result = await cmd.handler(bound)
    if (result.ok) return roundTrip(result.value)
    throw roundTrip(result.error)
  }

  return { register, invoke }
}
```

```ts tests
const settle = (p: Promise<unknown>) =>
  p.then((v) => ({ resolved: v }), (e) => ({ rejected: e }))

test('Ok resolves with the value', async () => {
  const b = createBridge()
  b.register('rename_clip', ['clip_id', 'new_name'], (a) => ({ ok: true, value: `clip ${a.clip_id} is now ${a.new_name}` }))
  expect(await settle(b.invoke('rename_clip', { clipId: 7, newName: 'intro' })))
    .toEqual({ resolved: 'clip 7 is now intro' })
})
test('Err rejects with the serialized error, not an Error object', async () => {
  const b = createBridge()
  b.register('export_clip', ['clip_name'], () => ({ ok: false, error: { kind: 'EmptyName', message: 'clip name must not be empty' } }))
  expect(await settle(b.invoke('export_clip', { clipName: '' })))
    .toEqual({ rejected: { kind: 'EmptyName', message: 'clip name must not be empty' } })
})
test('unknown command rejects with a string', async () => {
  const b = createBridge()
  expect(await settle(b.invoke('nope'))).toEqual({ rejected: 'Command nope not found' })
})
test('missing camelCase key rejects before the handler runs', async () => {
  const b = createBridge()
  const handler = fn(() => ({ ok: true as const, value: 1 }))
  b.register('export_clip', ['clip_name', 'steps'], handler)
  const r = await settle(b.invoke('export_clip', { clip_name: 'intro', steps: 2 }))
  expect(r).toEqual({ rejected: 'invalid args `clipName` for command `export_clip`: command export_clip missing required key clipName' })
  expect(handler).not.toHaveBeenCalled()
})
test('arguments go through JSON (a Date arrives as a string)', async () => {
  const b = createBridge()
  let seen: unknown = 'not called'
  b.register('schedule', ['at'], (a) => { seen = a.at; return { ok: true } })
  await b.invoke('schedule', { at: new Date(Date.UTC(2026, 0, 2)) })
  expect(seen).toBe('2026-01-02T00:00:00.000Z')
})
test('unit return value resolves to null', async () => {
  const b = createBridge()
  b.register('ping', [], () => ({ ok: true }))
  expect(await settle(b.invoke('ping'))).toEqual({ resolved: null })
})
test('return values are copies (serialized), not shared objects', async () => {
  const b = createBridge()
  const state = { count: 1 }
  b.register('stats', [], () => ({ ok: true, value: state }))
  const got = (await b.invoke('stats')) as { count: number }
  got.count = 99
  expect(state.count).toBe(1)
})
test('async handlers work', async () => {
  const b = createBridge()
  b.register('slow', ['ms'], async (a) => { await sleep(a.ms as number); return { ok: true, value: 'done' } })
  expect(await settle(b.invoke('slow', { ms: 5 }))).toEqual({ resolved: 'done' })
})
test('registering twice throws', () => {
  const b = createBridge()
  b.register('ping', [], () => ({ ok: true }))
  expect(() => b.register('ping', [], () => ({ ok: true }))).toThrow('command ping already registered')
})
```
:::

## Events: progress without a return value

A command returns **once**. An export that takes 30 seconds should report progress as it goes, and
for that Tauri has **events**: named messages with a JSON payload that any side can emit and any side
can listen to.

```rust
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]                  // event payloads need Serialize + Clone
#[serde(rename_all = "camelCase")]
struct ExportProgress { clip_name: String, done: u32, total: u32 }

#[tauri::command]
async fn export_clip(app: AppHandle, clip_name: String, steps: u32) -> Result<String, String> {
    for done in 1..=steps {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        app.emit("export-progress", ExportProgress { clip_name: clip_name.clone(), done, total: steps })
            .map_err(|e| e.to_string())?;
    }
    Ok(format!("exported {clip_name}.mp4"))
}
```

`AppHandle` is one of the **injected parameters**. Like `State` and `WebviewWindow`, Tauri fills it
in for you and JS never passes it. The `Emitter` trait provides `emit` (to every listener),
`emit_to("main", …)` (to one webview by label) and `emit_filter`.

```tsx
import { listen } from '@tauri-apps/api/event'

useEffect(() => {
  const unlisten = listen<ExportProgress>('export-progress', (e) => setProgress(e.payload))
  return () => { unlisten.then((stop) => stop()) }   // listen() returns Promise<UnlistenFn>
}, [])
```

| | Command (`invoke`) | Event (`emit`/`listen`) | Channel (`ipc::Channel<T>`) |
|---|---|---|---|
| Direction | JS → Rust → JS | either way, broadcast | Rust → one JS caller |
| Returns a value | yes (a Promise) | no | no, it streams messages |
| Typed / ordered | typed args and result | no typing, JSON only | typed, ordered, fast |
| Use for | "do X and give me the answer" | "something happened" (progress, file changed, tray click) | high-volume streams (file chunks, logs) |

:::warn title="Leaking listeners in React"
`listen()` is asynchronous. If you forget the cleanup, or call the result before the promise
resolves, every remount (React StrictMode mounts twice in dev) adds another listener, and the
progress bar receives each event two, three, four times. Keep the promise and call the
function it resolves to on unmount, as above.
:::

:::quiz id=rs-05-q5 xp=10
ClipDesk transcodes a 4 GB file and must show a live percentage. Which design fits best?
- [ ] One synchronous command that returns the final percentage when done.
- [ ] The frontend calls `invoke('get_percent')` in a `setInterval` every 10 ms.
- [x] An `async` command does the work and emits `export-progress` events (or sends on a `Channel`). It returns the final result as its `Result`.
- [ ] A command returns `Vec<u32>` with every percentage at once.
> Commands answer once; events (or a channel passed into the command) push intermediate updates. Making the
> command `async` keeps the work off the main thread so the window stays responsive. Polling works but
> wastes IPC calls and still needs the work to run somewhere that doesn't block.
:::

## Managed state: one value for the whole app

Commands are free functions, so where do you keep things that live across calls, like a database pool, a
cache or a counter? Tauri's answer is **managed state**: you hand a value to the app once, and any
command can ask for it by type.

```rust
use std::sync::Mutex;
use tauri::{Manager, State};

#[derive(Default)]
struct Stats { exports_run: u32 }

#[tauri::command]
fn export_count(stats: State<'_, Mutex<Stats>>) -> u32 {
    stats.lock().unwrap().exports_run
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Mutex::new(Stats::default()));    // registered once, by type
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![export_count])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- **Why `Mutex`?** Commands can run at the same time on different threads, and `State<T>` only gives
  you `&T` (a shared reference). To change the value you need *interior mutability*. Rust will not let
  you mutate through `&T` without a lock. That is the borrowing rule from earlier lessons, enforced across threads.
- **No `Arc` needed.** Tauri already keeps managed state in an `Arc` internally.
- **`std::sync::Mutex` is usually right**, even in async commands, as long as you don't hold the
  guard across an `.await`. Reach for `tokio::sync::Mutex` only if you must hold the lock while awaiting.
- **Lookup is by exact type, at runtime.** If you `manage(Mutex::new(Stats))` but a command asks for
  `State<'_, Stats>`, it still compiles. The invoke is then rejected with *"state not managed for field
  `stats` on command `export_count`. You must call `.manage()` before using this command"*. A type
  alias (`type AppState = Mutex<Stats>;`) used everywhere avoids the mismatch.
- Outside a command (in `setup`, a thread, a tray handler), use `app_handle.state::<Mutex<Stats>>()`.

:::quiz id=rs-05-q6 xp=15
`setup` calls `app.manage(Mutex::new(Stats::default()))`. A new command is written as
`fn reset(stats: State<'_, Stats>)`. What happens?
- [ ] `error[E0308]: mismatched types` at compile time.
- [ ] It works: Tauri unwraps the `Mutex` automatically.
- [x] It compiles. Calling it rejects with "state not managed for field `stats` on command `reset`...".
- [ ] It silently creates a second, default `Stats`.
> State is a type-keyed map filled at runtime, so the compiler cannot connect `manage(...)` with `State<T>`.
> `Stats` and `Mutex<Stats>` are different types. Calling `app.state::<Stats>()` from Rust would
> panic instead. A shared type alias prevents this.
:::

:::quiz id=rs-05-q7 xp=15
Will this async command compile?

```rust
#[tauri::command]
async fn export_clip(stats: State<'_, Mutex<Stats>>, clip_name: String) -> Result<u32, String> {
    let mut s = stats.lock().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    s.exports_run += 1;
    Ok(s.exports_run)
}
```
- [ ] Yes. It returns a `Result`, so borrowed `State` is allowed.
- [x] No: "future cannot be sent between threads safely", because `std::sync::MutexGuard` is not `Send` and lives across the `.await`.
- [ ] No: `error[E0499]`, `stats` is borrowed mutably twice.
- [ ] It compiles but deadlocks on the second call.
> Tauri runs async commands on a multi-threaded runtime, so the future must be `Send`. A std
> `MutexGuard` cannot move between threads. Do the `.await` first, then lock, update and drop the guard
> in a short block, or use `tokio::sync::Mutex` if you truly need the lock across the await.
:::

## Windows basics

The windows in `tauri.conf.json → app.windows` are created at startup. A window without a `label` gets
the label **`"main"`**, which is the name capability files and `emit_to` refer to. You can also create
windows from Rust:

```rust
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        w.set_focus().map_err(|e| e.to_string())?;           // already open: just focus it
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html#/settings".into()))
        .title("ClipDesk settings")
        .inner_size(480.0, 360.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

A command can also take `window: tauri::WebviewWindow` to learn **which** window called it
(`window.label()`). From JS, `getCurrentWindow()` in `@tauri-apps/api/window` can read state
(`title()`, `isMaximized()`) with the default permissions. **Changing** the window (`setTitle`,
`close`, `setSize`) needs explicit permissions such as `core:window:allow-set-title` in a capability.
The reasons are covered in **Tauri security: capabilities, permissions and plugins**.

:::info title="Your own commands and capabilities"
The template's `capabilities/default.json` grants `core:default` (events, read-only window info,
paths and more) to the window labelled `main`. Commands *you* define in the app are callable without
extra permissions. Plugin commands (fs, dialog, shell, …) and core window/webview *mutations* each need a permission listed there.
:::

:::cards id=rs-05-cards1 xp=15 title="Tauri 2 essentials"
Q: What renders the UI of a Tauri app?
A: The OS's system webview: WebView2 (Windows), WKWebView (macOS/iOS), WebKitGTK (Linux), System WebView (Android).
Q: Import path for `invoke` in Tauri 2?
A: `import { invoke } from '@tauri-apps/api/core'` (Tauri 1 used `@tauri-apps/api/tauri`).
Q: A Rust parameter `clip_name`. Which JS key by default?
A: `clipName`. Use `#[tauri::command(rename_all = "snake_case")]` to keep snake_case.
Q: How does a command report an error to JS?
A: Return `Result<T, E>` with `E: Serialize`. `Err` rejects the promise with the serialized value.
Q: What may an async command not do without returning `Result`?
A: Take borrowed parameters (`&str`, `State<'_, T>`).
Q: Payload requirements for `app.emit(...)`?
A: `Serialize + Clone`. Import the `tauri::Emitter` trait.
Q: How do commands share a counter or a pool?
A: `app.manage(Mutex::new(x))` in setup, then `State<'_, Mutex<X>>` as a command parameter.
Q: Why do `main.rs` and `lib.rs` both exist?
A: Mobile loads the app as a library through `#[cfg_attr(mobile, tauri::mobile_entry_point)] fn run()`. `main.rs` just calls `run()` on desktop.
Q: Default label of the first window?
A: `"main"`, used by capabilities and `emit_to`.
:::

:::lab id=rs-05-lab1 xp=100
title: ClipDesk: commands, progress events and managed state
Build a Tauri 2 + React app with three commands: `system_info` reads facts about the machine,
`export_clip` simulates an export and emits progress events, and `export_count` reads managed state.
The logic lives in plain Rust functions with `cargo test` unit tests.
Tested with Rust 1.97 (edition 2024), Tauri 2.12, `create-tauri-app` 4.7, Node 22+.

**0. Prerequisites** (once per machine; see the Tauri 2 "Prerequisites" page for details)

- Rust stable via `rustup` (`rustc --version` ≥ 1.85, needed for edition 2024) and Node.js 20.19+ or 22.12+ (Vite 8's requirement).
- **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **macOS:** `xcode-select --install`
- **Windows:** "Desktop development with C++" from the Visual Studio Build Tools. WebView2 is
  preinstalled on Windows 10 (1803+) and 11.

**1. Scaffold**

```bash
npm create tauri-app@latest clipdesk -- --template react-ts --manager npm --identifier com.example.clipdesk --yes
cd clipdesk
npm install
cd src-tauri
cargo add thiserror@2
cargo add tokio@1 --features time
cd ..
```

Check `src-tauri/Cargo.toml`. It should say `edition = "2024"` (if an older template says `2021`,
change it), and `[dependencies]` should now list `thiserror = "2"` and
`tokio = { version = "1", features = ["time"] }` next to `tauri`, `serde` and `serde_json`. Tauri
already runs on tokio, so the extra dependency only adds the `time` feature for `sleep`.

**2. `src-tauri/src/info.rs`**: system info as a pure function

```rust
use serde::Serialize;

/// What the frontend receives from `system_info`.
/// `rename_all = "camelCase"` turns `cpu_count` into `cpuCount` in JSON.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub family: String,
    pub cpu_count: usize,
    pub app_version: String,
}

/// Pure function: easy to unit-test without starting a window.
pub fn collect(app_version: &str) -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
        cpu_count: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        app_version: app_version.to_string(),
    }
}
```

**3. `src-tauri/src/export.rs`**: errors, progress payload, state

```rust
use serde::Serialize;
use std::sync::Mutex;

/// Payload of the `export-progress` event. Events need `Serialize + Clone`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub clip_name: String,
    pub done: u32,
    pub total: u32,
    pub percent: u32,
}

/// Errors a command can return. The frontend sees them as a rejected promise.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ExportError {
    #[error("clip name must not be empty")]
    EmptyName,
    #[error("steps must be between 1 and 100, got {0}")]
    InvalidSteps(u32),
}

// Tauri needs the error to be Serialize. Sending the Display text is the simplest contract.
impl Serialize for ExportError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Managed state: one instance for the whole app, shared by every command call.
#[derive(Debug, Default)]
pub struct Stats {
    pub exports_run: u32,
    pub last_clip: Option<String>,
}

pub fn validate(clip_name: &str, steps: u32) -> Result<(), ExportError> {
    if clip_name.trim().is_empty() {
        return Err(ExportError::EmptyName);
    }
    if steps == 0 || steps > 100 {
        return Err(ExportError::InvalidSteps(steps));
    }
    Ok(())
}

pub fn progress(clip_name: &str, done: u32, total: u32) -> ExportProgress {
    ExportProgress {
        clip_name: clip_name.to_string(),
        done,
        total,
        percent: done * 100 / total,
    }
}

/// Locks, updates, unlocks (the guard drops at the end of the function). Returns the new count.
pub fn record_export(stats: &Mutex<Stats>, clip_name: &str) -> u32 {
    let mut s = stats.lock().unwrap();
    s.exports_run += 1;
    s.last_clip = Some(clip_name.to_string());
    s.exports_run
}
```

**4. Replace `src-tauri/src/lib.rs`**: the commands and the tests (leave `main.rs` as generated)

```rust
mod export;
mod info;

use std::sync::Mutex;
use std::time::Duration;

use export::{ExportError, ExportProgress, Stats};
use info::SystemInfo;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn system_info(app: AppHandle) -> SystemInfo {
    let version = app.package_info().version.to_string();
    info::collect(&version)
}

// async + borrowed State<'_> => the command must return a Result.
#[tauri::command]
async fn export_clip(
    app: AppHandle,
    stats: State<'_, Mutex<Stats>>,
    clip_name: String,
    steps: u32,
) -> Result<String, ExportError> {
    export::validate(&clip_name, steps)?;
    for done in 1..=steps {
        tokio::time::sleep(Duration::from_millis(150)).await; // pretend to encode a chunk
        let payload: ExportProgress = export::progress(&clip_name, done, steps);
        // Ignore a failed emit (e.g. window closing); the export itself still succeeds.
        let _ = app.emit("export-progress", payload);
    }
    // Lock only AFTER the last .await: a std MutexGuard must not live across an await point.
    let count = export::record_export(&stats, &clip_name);
    Ok(format!("exported {clip_name}.mp4 (export #{count})"))
}

#[tauri::command]
fn export_count(stats: State<'_, Mutex<Stats>>) -> u32 {
    stats.lock().unwrap().exports_run
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(Mutex::new(Stats::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![system_info, export_clip, export_count])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::export::*;
    use super::info;
    use std::sync::Mutex;

    #[test]
    fn system_info_reports_this_machine() {
        let i = info::collect("0.1.0");
        assert_eq!(i.os, std::env::consts::OS);
        assert!(i.cpu_count >= 1);
        assert_eq!(i.app_version, "0.1.0");
    }

    #[test]
    fn system_info_serializes_as_camel_case() {
        let json = serde_json::to_value(info::collect("0.1.0")).unwrap();
        assert!(json.get("cpuCount").is_some());
        assert!(json.get("appVersion").is_some());
        assert!(json.get("cpu_count").is_none());
    }

    #[test]
    fn validate_rejects_bad_input() {
        assert_eq!(validate("  ", 5), Err(ExportError::EmptyName));
        assert_eq!(validate("intro", 0), Err(ExportError::InvalidSteps(0)));
        assert_eq!(validate("intro", 101), Err(ExportError::InvalidSteps(101)));
        assert_eq!(validate("intro", 10), Ok(()));
    }

    #[test]
    fn errors_serialize_to_their_message() {
        let json = serde_json::to_string(&ExportError::InvalidSteps(0)).unwrap();
        assert_eq!(json, "\"steps must be between 1 and 100, got 0\"");
    }

    #[test]
    fn progress_payload_has_percent() {
        let p = progress("intro", 3, 4);
        assert_eq!(p.percent, 75);
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["clipName"], "intro");
        assert_eq!(json["done"], 3);
    }

    #[test]
    fn record_export_counts_and_remembers_last_clip() {
        let stats = Mutex::new(Stats::default());
        assert_eq!(record_export(&stats, "intro"), 1);
        assert_eq!(record_export(&stats, "outro"), 2);
        assert_eq!(stats.lock().unwrap().last_clip.as_deref(), Some("outro"));
    }
}
```

**5. Replace `src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type SystemInfo = { os: string; arch: string; family: string; cpuCount: number; appVersion: string };
type ExportProgress = { clipName: string; done: number; total: number; percent: number };

function App() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [clipName, setClipName] = useState("intro");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState("");
  const [count, setCount] = useState(0);

  useEffect(() => {
    invoke<SystemInfo>("system_info").then(setInfo);
    invoke<number>("export_count").then(setCount);
    // listen() resolves to an unlisten function: keep the promise and clean up on unmount.
    const unlisten = listen<ExportProgress>("export-progress", (e) => setProgress(e.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  async function exportClip(steps: number) {
    setResult("");
    try {
      // JS keys are camelCase; Tauri maps clipName -> clip_name.
      const msg = await invoke<string>("export_clip", { clipName, steps });
      setResult(msg);
      setCount(await invoke<number>("export_count"));
    } catch (err) {
      setResult(`Error: ${String(err)}`);
    }
  }

  return (
    <main className="container">
      <h1>ClipDesk</h1>
      {info && (
        <p data-testid="sysinfo">
          {info.os} / {info.arch} ({info.family}), {info.cpuCount} CPUs, v{info.appVersion}
        </p>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          exportClip(10);
        }}
      >
        <input value={clipName} onChange={(e) => setClipName(e.currentTarget.value)} />
        <button type="submit">Export</button>
        <button type="button" onClick={() => exportClip(0)}>Export (bad steps)</button>
      </form>
      {progress && (
        <progress max={progress.total} value={progress.done}>{progress.percent}%</progress>
      )}
      <p>{result}</p>
      <p>Exports this session: {count}</p>
    </main>
  );
}

export default App;
```

**6. Run the tests, then the app**

```bash
cd src-tauri
cargo test
cd ..
npx tsc --noEmit        # the frontend type-checks
npm run tauri dev
```

Expected `cargo test` output (the first build compiles Tauri and takes a minute or two):

```text
     Running unittests src/lib.rs (target/debug/deps/clipdesk_lib-…)

running 6 tests
test tests::errors_serialize_to_their_message ... ok
test tests::record_export_counts_and_remembers_last_clip ... ok
test tests::progress_payload_has_percent ... ok
test tests::validate_rejects_bad_input ... ok
test tests::system_info_serializes_as_camel_case ... ok
test tests::system_info_reports_this_machine ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

In the window you should see:

```text
ClipDesk
linux / x86_64 (unix), 16 CPUs, v0.1.0          ← your OS, arch and CPU count
[intro      ] [Export] [Export (bad steps)]
```

- **Export**: the progress bar fills in 10 steps over about 1.5 s, then
  `exported intro.mp4 (export #1)` appears and the counter shows `Exports this session: 1`.
- **Export (bad steps)**: `Error: steps must be between 1 and 100, got 0` appears. The counter is unchanged.
- Clear the input and press **Export**: `Error: clip name must not be empty`.

**7. Break it on purpose** (then undo each change)

1. In `App.tsx`, change `{ clipName, steps }` to `{ clip_name: clipName, steps }`. Export now shows
   ``Error: invalid args `clipName` for command `export_clip`: command export_clip missing required key clipName``.
2. In `export_clip`, put `let mut s = stats.lock().unwrap();` right after `export::validate(...)?;`
   (before the loop), and replace the `let count = ...` line with `s.exports_run += 1; let count = s.exports_run;`.
   `cargo build` fails with "future cannot be sent between threads safely": the guard `s` lives across the `.await` in the loop.
3. In `setup`, change `Mutex::new(Stats::default())` to `Stats::default()`. It compiles. The UI then logs
   "state not managed for field `stats` on command `export_count`" in the webview devtools
   (right-click → Inspect in dev builds).

:::tip
Open the webview devtools with right-click → **Inspect** (or Ctrl+Shift+I / Cmd+Option+I) in
`tauri dev`. Rust `println!` output goes to the terminal that runs `tauri dev`.
:::

- [ ] `cargo test` in `src-tauri` passes all 6 tests
- [ ] `npm run tauri dev` opens a ClipDesk window that shows your OS, architecture and CPU count from `system_info`
- [ ] Export fills the progress bar step by step from `export-progress` events, then shows the result message
- [ ] The export counter increases across exports (managed state) and an invalid export leaves it unchanged
- [ ] Invalid input shows the `ExportError` message from a rejected promise, and the app does not crash
- [ ] You reproduced the three "break it on purpose" errors and can explain each
:::

## How it breaks in practice

- **"Command X not found."** The function has `#[tauri::command]` but is missing from
  `generate_handler!`, or a second `.invoke_handler(...)` call replaced the first. Register every
  command in one list.
- **"invalid args `fooBar` … missing required key fooBar."** Snake_case keys sent from JS, or a renamed
  Rust parameter. Remember that renaming a Rust parameter **changes the public JS API**.
- **A cryptic `E0599: the method blocking_kind exists … but its trait bounds were not satisfied`.**
  The command's return or error type does not implement `Serialize`. The macro's generated code fails,
  not your line. Add `#[derive(Serialize)]` or a manual `impl Serialize` for the error.
- **Window freezes during a long operation.** A synchronous command runs on the main thread. Make it
  `async` (or `#[tauri::command(async)]`), and use `tauri::async_runtime::spawn_blocking` for CPU-heavy work.
- **"future cannot be sent between threads safely."** A `std::sync::MutexGuard` (or `Rc`, or
  `RefCell` borrow) is alive across an `.await`. Shrink the lock scope.
- **"state not managed for field …"** The type in `State<'_, T>` does not exactly match what you passed to
  `manage()`. Use one type alias.
- **The progress bar jumps or counts double.** Duplicate listeners from a missing `unlisten` (or React
  StrictMode's double mount). Clean up in the effect.
- **Works on Windows, broken on macOS/Linux.** A CSS or JS feature that WebKit does not support yet. The
  system webview is not Chromium everywhere. Test on each OS in CI (see **Shipping: bundles, signing,
  auto-update and CI**).
- **Copy-pasted Tauri 1 code.** `allowlist` and `@tauri-apps/api/tauri` do not exist in v2, and
  `get_window` now sits behind the `unstable` feature with a different meaning (a bare window without its
  webview). Use `get_webview_window`. The v2 docs and the CLI's `tauri migrate` command help.
- **The app exits (or a call hangs) instead of showing an error.** `unwrap()` panicked in a command.
  A panic on the main thread, or any panic with `panic = "abort"` in the release profile, ends the
  process. A panicking async command leaves its promise pending forever. Return `Result`.

:::pro title="Keep commands thin"
In the lab, the commands only translate between IPC and plain functions (`info::collect`,
`export::validate`, `export::record_export`). That split is what makes the logic testable with
`cargo test` without a window. Teams usually go further: a `commands.rs` module of thin `pub` commands, a
domain module with no `tauri` imports, and one shared error type. A generator like `tauri-specta`
can emit TypeScript types for the commands so the camelCase contract is checked by `tsc`.
:::

## Recap

- Tauri = **your web frontend in the OS's webview** + **a Rust core**. Installers are small, but you
  test on several browser engines.
- Layout: frontend at the root, Cargo project in `src-tauri/` with `tauri.conf.json`, `capabilities/`,
  `main.rs` (a thin desktop entry) and `lib.rs` (`run()` with `mobile_entry_point`).
- `npm create tauri-app`, then `npm run tauri dev` (Vite + hot reload), then `npm run tauri build` (assets embedded).
- **Commands:** `#[tauri::command]` plus one `generate_handler!`. From JS: `invoke('name', { camelCaseArgs })`
  from `@tauri-apps/api/core`. Args are `Deserialize`, results are `Serialize`, and `Result::Err` rejects the promise.
- **Async commands** keep the main thread free. They need `Result` when they borrow, and their futures must be `Send`.
- **Events** (`Emitter::emit` / `listen`) push progress and notifications. Always unlisten.
  **Channels** handle fast ordered streams.
- **Managed state:** `app.manage(Mutex::new(x))` plus `State<'_, Mutex<X>>`. Types must match exactly.
  Don't hold a std guard across `.await`.
- Windows have labels (`"main"` by default) and can be created with `WebviewWindowBuilder`. Mutating windows from JS
  needs permissions, which come next in **Tauri security: capabilities, permissions and plugins**.
