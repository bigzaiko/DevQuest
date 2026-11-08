---
id: rs-06
title: "Tauri security: capabilities, permissions and plugins"
level: advanced
minutes: 115
xp: 180
summary: Treat the webview as untrusted, then grant it only what it needs. Tauri 2's ACL (permissions, sets, capabilities, scopes), CSP, the official plugins, sidecars with validated arguments, and a test that proves a forbidden call is rejected.
---

In **Tauri 2: a desktop app with a web frontend** you wrote `#[tauri::command]` functions and
called them with `invoke()`. It worked on the first try, which is exactly the problem this lesson
is about. Every command you register is a door from a web page into native code. Native code can
read any file the user can read, start processes and talk to the network with no CORS. If anything
in the web page goes wrong, the attacker gets whatever you left open.

Tauri 2 ships an **access control list (ACL)**: *permissions* describe which commands (and which
arguments) are allowed, *capabilities* hand permissions to specific windows on specific platforms,
and everything else is denied. This lesson teaches you to use it on purpose. The running example
is **ClipDesk**, a small desktop tool that lists video clips and asks a helper binary to probe
them.

:::info title="Words you'll meet in this lesson"
- **IPC** (inter-process communication): how the webview talks to the Rust core. `invoke()` sends
  a message and Rust answers it.
- **ACL**: the rules that decide whether an IPC message may run at all.
- **Permission**: a named rule such as `fs:allow-read-file` that allows (or denies) commands and
  can carry a *scope*.
- **Scope**: the *arguments* a permission covers, for example which paths, URLs or programs.
- **Capability**: a file that grants a list of permissions to window labels, optionally only on
  some platforms or for some remote URLs.
- **Sidecar**: an external binary (a CLI tool) bundled with your app and started by it.
- **CSP** (Content Security Policy): browser rules that limit which scripts, styles and
  connections a page may use.
:::

## Why the webview is "untrusted-ish"

Your frontend is *your* code, so why not trust it? Because of what gets **into** it:

- **Data you render.** A clip's title comes from a file's metadata. If you ever pass it to
  `innerHTML` or a markdown renderer without sanitising it, that title can become a script (XSS).
- **Dependencies.** A typical React app pulls in hundreds of npm packages. One compromised package
  runs with your page's privileges.
- **Remote content.** An embedded help page, an iframe, an OAuth redirect: anything not shipped
  inside your bundle.
- **The system webview itself.** Tauri uses WebView2, WKWebView or WebKitGTK. They get security
  patches on the OS schedule, not yours.

So draw the boundary like this:

```text
 ┌──────────────── webview (JS) ────────────────┐            ┌───────── Rust core ─────────┐
 │ your React code + npm deps + rendered data   │   invoke   │  ACL check  ─► command fn   │
 │ (assume it CAN be compromised)               │ ─────────► │  (window, URL, command,     │
 │                                              │   IPC msg  │   scope)       │             │
 └──────────────────────────────────────────────┘            │                ▼             │
                                                             │  YOUR validation of args    │
                                                             │                ▼             │
                                                             │  files, processes, network  │
                                                             └─────────────────────────────┘
       trust boundary ──────────────────────────────► here, at the IPC message
```

Two gates sit on the Rust side. The **ACL** decides "may this window call this command with this
kind of argument?". **Your own code** then validates the actual values, because the ACL knows
nothing about what your command does with them. The Tauri docs say it directly: capabilities do
not protect against "incorrect scope checks in the command implementation" or "intentional
bypasses from Rust code".

:::quiz id=rs-06-q1 xp=10
An attacker gets an XSS payload running inside ClipDesk's `main` window. What can the payload do
through Tauri?
- [ ] Nothing: Tauri isolates JavaScript from Rust completely.
- [ ] Anything Rust can do, because `invoke` reaches every registered command.
- [x] Call exactly the commands, with the arguments, that the capabilities granted to the `main` window allow.
- [ ] Only call commands whose names start with `allow-`.
> The ACL limits the damage of a compromised frontend to what the window was granted. That is why
> least privilege matters: whatever you grant "just in case" becomes the attacker's toolbox.
:::

## The Tauri 2 ACL: permissions, sets, capabilities

:::warn title="Tauri 1 tutorials are wrong here"
Tauri 1 had an `allowlist` in `tauri.conf.json` and imported from `@tauri-apps/api/tauri`. Neither
exists in Tauri 2. If a blog post shows `"allowlist": { "fs": { "all": true } }`, close the tab. In
Tauri 2 the ACL lives in `src-tauri/capabilities/` and `src-tauri/permissions/`, and core APIs are
imported from `@tauri-apps/api/core`.
:::

### Permissions

A **permission** has an identifier and allows or denies commands. Plugins ship their permissions,
and you reference them as `<plugin>:<permission>`:

| Identifier | Meaning |
|---|---|
| `fs:allow-read-text-file` | allow the fs plugin's `read_text_file` command (no paths yet: that needs a scope) |
| `fs:deny-remove` | explicitly deny the `remove` command |
| `fs:default` | the plugin's **default set**: a reviewed, conservative bundle |
| `core:window:allow-set-title` | core APIs are permissions too, under `core:` |
| `allow-probe-clip` | one of **your app's** commands (no prefix) |

Plugins generate `allow-<command>` and `deny-<command>` for every command. You can write your own
permissions in TOML under `src-tauri/permissions/`:

```toml
# src-tauri/permissions/library.toml
[[permission]]
identifier = "read-library"
description = "List and probe clips, nothing destructive."
commands.allow = ["list_clips", "probe_clip"]

[[set]]
identifier = "viewer"
description = "Everything a read-only window needs."
permissions = ["read-library", "core:default", "opener:default"]
```

A **permission set** (`[[set]]`) is a named group of permissions. Sets can contain other sets, which
is how `fs:default` bundles "create the app folders" with "deny the webview's own data folder".

### Your own commands are open until you say otherwise

This surprises many people: **app commands are allowed for every local window by default**. The ACL
only applies to your own commands once you list them in `build.rs`:

```rust
// src-tauri/build.rs
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["probe_clip", "wipe_library"]),
        ),
    )
    .expect("failed to run tauri-build");
}
```

After that, the build generates `allow-probe-clip`, `deny-probe-clip` and so on (in
`src-tauri/permissions/autogenerated/`), and **a command nobody granted is rejected**. Plugin
commands are always behind the ACL.

### Capabilities

A **capability** connects permissions to windows. One JSON (or TOML) file per capability in
`src-tauri/capabilities/`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-window",
  "description": "What the main ClipDesk window may do",
  "windows": ["main"],
  "platforms": ["linux", "macOS", "windows"],
  "permissions": [
    "core:default",
    "opener:default",
    "allow-probe-clip",
    {
      "identifier": "fs:allow-read-text-file",
      "allow": [{ "path": "$APPDATA/library/**" }],
      "deny": [{ "path": "$APPDATA/library/secrets/**" }]
    }
  ]
}
```

| Field | What it does |
|---|---|
| `identifier` | the name; `tauri.conf.json > app > security > capabilities` can list identifiers to enable only some files (otherwise **every file in the folder is enabled**) |
| `windows` / `webviews` | window or webview **labels**, glob patterns allowed (`"editor-*"`). Labels, not titles. |
| `platforms` | optional subset of `linux`, `macOS`, `windows`, `iOS`, `android`; omitted = all |
| `remote.urls` | lets pages from these URLs (e.g. `"https://*.example.com"`) use the permissions; without it only your bundled frontend can |
| `permissions` | strings, or objects that add **scope** entries (`allow` / `deny`) to one permission |

The `$schema` line points at a schema that `tauri build`/`tauri dev` generate in
`src-tauri/gen/schemas/`, so your editor autocompletes every permission identifier your plugins
provide. Use it: a typo in an identifier fails the build, and you want to see that while typing.

```text
 permission (TOML)          permission set            capability (JSON/TOML)        window
 ┌──────────────────┐      ┌───────────────┐      ┌────────────────────────┐     ┌────────┐
 │ allow-probe-clip │─┐    │ viewer        │      │ main-window            │     │ "main" │
 │ commands.allow   │ ├──► │  read-library │ ───► │ windows: ["main"]      │ ──► │        │
 └──────────────────┘ │    │  core:default │      │ platforms: [desktop..] │     └────────┘
 ┌──────────────────┐ │    └───────────────┘      │ permissions + scopes   │
 │ fs:allow-read-.. │─┘                           └────────────────────────┘
 │ + scope allow/deny│
 └──────────────────┘
```

The rules that matter at runtime:

1. **Default deny.** No capability that matches the window, platform and origin grants the command,
   so the call fails.
2. **Deny wins.** A `deny-…` permission beats any `allow-…`, and a scope `deny` entry beats any scope
   `allow` entry ("deny always supersedes the allow scope", in the Tauri docs).
3. **Capabilities merge.** A window in two capabilities gets the union of both. A broad
   `"windows": ["*"]` capability silently adds to every carefully trimmed one.
4. **Local vs remote.** Without `remote.urls`, only content served from your bundle (or `devUrl` in
   development) can call anything.

:::quiz id=rs-06-q2 xp=10
`capabilities/` contains `main.json` (windows `["main"]`, grants `allow-probe-clip`) and
`tools.json` (windows `["*"]`, grants `fs:default` and `allow-wipe-library`). Which windows may call
`wipe_library`?
- [ ] None: `main.json` doesn't grant it, and the most specific capability wins.
- [ ] Only windows not named `main`.
- [x] Every window, including `main`: `"*"` matches all labels and capabilities merge.
- [ ] Only the window whose **title** is "Tools".
> There is no "most specific wins". A window gets the union of every capability whose `windows`
> pattern matches its label. Keep `"*"` capabilities tiny (`core:default` at most), and never put
> anything dangerous in them.
:::

:::quiz id=rs-06-q3 xp=10
You list `probe_clip` and `wipe_library` in `AppManifest::commands`. The only capability grants
`allow-probe-clip` to `main`. What does `invoke('wipe_library')` from `main` return?
- [ ] `"library wiped"`: registered app commands are always callable.
- [x] A rejected promise with an error like `wipe_library not allowed. Permissions associated with this command: allow-wipe-library`.
- [ ] Nothing: the build fails because `wipe_library` isn't granted anywhere.
- [ ] A compile error E0425, because the command is unused.
> Once the commands are in the app manifest, each one is behind the ACL and nothing is granted
> automatically. The error even names the permission you'd need. The build does not fail: having
> a registered command that no window can call is a valid (and sometimes intended) state.
:::

Now build the resolver yourself. Tauri's real implementation is in Rust (`tauri-utils` resolves the
ACL at build time; the runtime authority checks each call), but the logic fits in a page of
TypeScript.

:::challenge id=rs-06-c1 lang=ts xp=60
title: A capability resolver
Write `canInvoke(caps, catalog, req)`. It decides whether window `req.window` on platform
`req.platform` may call `req.command`, optionally with a scoped argument `req.arg` (a path or URL).

**The catalog** maps a permission identifier to a definition:
- `commands.allow` / `commands.deny`: command names it allows / denies,
- `scope.allow` / `scope.deny`: glob patterns for arguments,
- `permissions`: if present, it's a **set**: expand these identifiers (sets can nest).

**A capability** applies when one of its `windows` globs matches the label **and** it has no
`platforms` or lists `req.platform`. Its `permissions` are identifiers or objects
`{ identifier, allow?, deny? }` that add scope globs to that permission.

**Rules**, in order:
1. Collect every permission (sets expanded) from every applying capability. An identifier missing
   from the catalog **throws** (Tauri fails the build).
2. Any collected permission denies the command → `false`.
3. No collected permission allows the command → `false` (default deny).
4. If `req.arg` is undefined → `true`. Otherwise use the scope globs of the collected permissions
   that allow the command or that allow no commands at all (scope-only permissions such as
   `fs:scope`). A matching `deny` glob → `false`; otherwise `true` only if some `allow` glob
   matches (no allow globs → `false`).

`globMatch(pattern, text)` is provided: `*` matches anything except `/`, `**` matches anything.

hint: Write a recursive `expand(id, out)` that throws on unknown ids and recurses into `def.permissions`.
hint: Keep the inline `allow`/`deny` globs next to the definition: collect `{ def, extraAllow, extraDeny }` items.
hint: Check `commands.deny` across all items first, then `commands.allow`, then scopes.

```ts starter
type Platform = 'linux' | 'macOS' | 'windows' | 'iOS' | 'android'
interface PermissionDef {
  commands?: { allow?: string[]; deny?: string[] }
  scope?: { allow?: string[]; deny?: string[] }
  permissions?: string[] // a permission set
}
type PermissionEntry = string | { identifier: string; allow?: string[]; deny?: string[] }
interface Capability {
  identifier: string
  windows: string[]
  platforms?: Platform[]
  permissions: PermissionEntry[]
}
interface Request { window: string; platform: Platform; command: string; arg?: string }

export function globMatch(pattern: string, text: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') { re += '.*'; i++ }
    else if (ch === '*') re += '[^/]*'
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$').test(text)
}

export function canInvoke(caps: Capability[], catalog: Record<string, PermissionDef>, req: Request): boolean {
  // TODO: implement the four rules
  return true
}
```

```ts solution
type Platform = 'linux' | 'macOS' | 'windows' | 'iOS' | 'android'
interface PermissionDef {
  commands?: { allow?: string[]; deny?: string[] }
  scope?: { allow?: string[]; deny?: string[] }
  permissions?: string[] // a permission set
}
type PermissionEntry = string | { identifier: string; allow?: string[]; deny?: string[] }
interface Capability {
  identifier: string
  windows: string[]
  platforms?: Platform[]
  permissions: PermissionEntry[]
}
interface Request { window: string; platform: Platform; command: string; arg?: string }

export function globMatch(pattern: string, text: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') { re += '.*'; i++ }
    else if (ch === '*') re += '[^/]*'
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$').test(text)
}

interface Granted { def: PermissionDef; extraAllow: string[]; extraDeny: string[] }

export function canInvoke(caps: Capability[], catalog: Record<string, PermissionDef>, req: Request): boolean {
  const granted: Granted[] = []

  const expand = (id: string, extraAllow: string[], extraDeny: string[]) => {
    const def = catalog[id]
    if (!def) throw new Error(`unknown permission "${id}"`)
    if (def.permissions) {
      for (const inner of def.permissions) expand(inner, extraAllow, extraDeny)
      return
    }
    granted.push({ def, extraAllow, extraDeny })
  }

  for (const cap of caps) {
    const windowOk = cap.windows.some(w => globMatch(w, req.window))
    const platformOk = !cap.platforms || cap.platforms.includes(req.platform)
    if (!windowOk || !platformOk) continue
    for (const entry of cap.permissions) {
      if (typeof entry === 'string') expand(entry, [], [])
      else expand(entry.identifier, entry.allow ?? [], entry.deny ?? [])
    }
  }

  if (granted.some(g => g.def.commands?.deny?.includes(req.command))) return false
  if (!granted.some(g => g.def.commands?.allow?.includes(req.command))) return false
  if (req.arg === undefined) return true

  const relevant = granted.filter(g => {
    const allows = g.def.commands?.allow ?? []
    return allows.includes(req.command) || allows.length === 0
  })
  const allowGlobs = relevant.flatMap(g => [...(g.def.scope?.allow ?? []), ...g.extraAllow])
  const denyGlobs = relevant.flatMap(g => [...(g.def.scope?.deny ?? []), ...g.extraDeny])
  const arg = req.arg
  if (denyGlobs.some(p => globMatch(p, arg))) return false
  return allowGlobs.some(p => globMatch(p, arg))
}
```

```ts tests
const catalog = {
  'core:default': { commands: { allow: ['core_ping'] } },
  'allow-probe-clip': { commands: { allow: ['probe_clip'] } },
  'allow-wipe-library': { commands: { allow: ['wipe_library'] } },
  'deny-wipe-library': { commands: { deny: ['wipe_library'] } },
  'fs:allow-read-file': { commands: { allow: ['fs_read_file'] } },
  'fs:scope-video': { scope: { allow: ['/home/me/Videos/**'] } },
  'fs:deny-secrets': { scope: { deny: ['**/.ssh/**'] } },
  'fs:viewer': { permissions: ['fs:allow-read-file', 'fs:scope-video', 'fs:deny-secrets'] },
  'viewer': { permissions: ['core:default', 'fs:viewer'] },
  'nfc:allow-scan': { commands: { allow: ['nfc_scan'] } },
}
const main = { identifier: 'main', windows: ['main'], permissions: ['allow-probe-clip', 'core:default'] }

test('a granted command is allowed for the matching window', () => {
  expect(canInvoke([main], catalog, { window: 'main', platform: 'linux', command: 'probe_clip' })).toBe(true)
})
test('default deny: an ungranted command is rejected', () => {
  expect(canInvoke([main], catalog, { window: 'main', platform: 'linux', command: 'wipe_library' })).toBe(false)
})
test('other windows get nothing', () => {
  expect(canInvoke([main], catalog, { window: 'preview', platform: 'linux', command: 'probe_clip' })).toBe(false)
})
test('window labels are globs', () => {
  const editors = { identifier: 'editors', windows: ['editor-*'], permissions: ['allow-probe-clip'] }
  expect(canInvoke([editors], catalog, { window: 'editor-2', platform: 'macOS', command: 'probe_clip' })).toBe(true)
  expect(canInvoke([editors], catalog, { window: 'main', platform: 'macOS', command: 'probe_clip' })).toBe(false)
})
test('platforms limit where a capability applies', () => {
  const mobile = { identifier: 'mobile', windows: ['main'], platforms: ['iOS', 'android'], permissions: ['nfc:allow-scan'] }
  expect(canInvoke([mobile], catalog, { window: 'main', platform: 'android', command: 'nfc_scan' })).toBe(true)
  expect(canInvoke([mobile], catalog, { window: 'main', platform: 'windows', command: 'nfc_scan' })).toBe(false)
})
test('capabilities merge, and deny beats allow', () => {
  const everyone = { identifier: 'everyone', windows: ['*'], permissions: ['allow-wipe-library'] }
  expect(canInvoke([main, everyone], catalog, { window: 'main', platform: 'linux', command: 'wipe_library' })).toBe(true)
  const locked = { identifier: 'locked', windows: ['main'], permissions: ['deny-wipe-library'] }
  expect(canInvoke([main, everyone, locked], catalog, { window: 'main', platform: 'linux', command: 'wipe_library' })).toBe(false)
})
test('nested permission sets are expanded', () => {
  const cap = { identifier: 'v', windows: ['main'], permissions: ['viewer'] }
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'core_ping' })).toBe(true)
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'fs_read_file', arg: '/home/me/Videos/a/b.mp4' })).toBe(true)
})
test('scope: outside the allow globs is rejected, deny beats allow', () => {
  const cap = { identifier: 'v', windows: ['main'], permissions: ['viewer'] }
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'fs_read_file', arg: '/etc/passwd' })).toBe(false)
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'fs_read_file', arg: '/home/me/Videos/.ssh/id_ed25519' })).toBe(false)
})
test('a command with no scope at all rejects any argument', () => {
  const cap = { identifier: 'r', windows: ['main'], permissions: ['fs:allow-read-file'] }
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'fs_read_file', arg: '/home/me/Videos/a.mp4' })).toBe(false)
})
test('inline allow/deny on a capability entry add to the scope', () => {
  const cap = { identifier: 'i', windows: ['main'], permissions: [
    { identifier: 'fs:allow-read-file', allow: ['/data/clips/*'], deny: ['/data/clips/private-*'] },
  ] }
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'fs_read_file', arg: '/data/clips/a.mp4' })).toBe(true)
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'fs_read_file', arg: '/data/clips/private-a.mp4' })).toBe(false)
  expect(canInvoke([cap], catalog, { window: 'main', platform: 'linux', command: 'fs_read_file', arg: '/data/clips/sub/a.mp4' })).toBe(false)
})
test('unknown permission identifiers throw', () => {
  const bad = { identifier: 'bad', windows: ['main'], permissions: ['fs:allow-everything'] }
  expect(() => canInvoke([bad], catalog, { window: 'main', platform: 'linux', command: 'probe_clip' })).toThrow()
})
```
:::

## Scopes: which arguments are allowed

Allowing a command is half the job. `fs:allow-read-text-file` without a scope reads nothing;
with `"$HOME/**"` it reads the user's SSH keys. Scopes are where permissions get real:

| Plugin | Scope entry | Example |
|---|---|---|
| fs | `{ "path": "…" }` with base-dir variables | `$APPDATA/**`, `$VIDEO/ClipDesk/**`, `$HOME/.ssh/**` (deny) |
| opener | `{ "url": "…" }` or `{ "path": "…" }` | `https://docs.example.com/*` |
| http | `{ "url": "…" }` | `https://api.example.com/*` |
| shell | `{ "name", "cmd" or "sidecar": true, "args" }` | see the next section |

Path variables like `$APPDATA`, `$APPLOCALDATA`, `$VIDEO`, `$DOCUMENT`, `$RESOURCE` resolve to the
right folder on each OS. Plugins also ship ready-made scope permissions, for example
`fs:scope-video-recursive` or `fs:scope-appdata-recursive`, which you combine with an
`allow-` command permission.

:::pro title="How seniors size scopes"
Start from **what the feature needs**, not what's convenient. "Import clips the user picked" needs
no fs scope at all: the dialog plugin returns the picked path and your Rust command reads it.
"Cache thumbnails" needs `$APPCACHE/thumbs/**`. When a reviewer sees `$HOME/**` or `**` in a scope,
they will ask you to justify it in writing.
:::

## CSP: shrink what can run in the page

The ACL limits what a compromised page can *do*. A **Content Security Policy** makes the
compromise less likely in the first place: no inline scripts, no `eval`, no loading code from other
origins. Tauri injects your CSP into every HTML file at build time and adds hashes and nonces for
its own scripts:

```json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data:; object-src 'none'; base-uri 'none'",
      "devCsp": "default-src 'self'; connect-src ipc: http://ipc.localhost ws://localhost:1420; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
      "freezePrototype": true
    }
  }
}
```

- `connect-src ipc: http://ipc.localhost` keeps `invoke()` working. The IPC uses a custom protocol
  (`ipc:` on macOS/Linux/iOS; `http://ipc.localhost` on Windows/Android). Forget it and every
  command fails with a CSP error in the devtools console.
- `devCsp` (if set) is used by `tauri dev` instead of `csp`. Vite's hot reload needs its WebSocket.
- `freezePrototype` freezes `Object.prototype`, which blocks prototype-pollution tricks against
  the IPC objects.
- If you show local files (thumbnails) through the asset protocol, add `asset: http://asset.localhost`
  to `img-src`/`media-src`. The protocol is off by default: turn it on with
  `app.security.assetProtocol.enable` (plus the `protocol-asset` feature on the `tauri` crate) and
  scope it under `app.security.assetProtocol.scope`.

:::quiz id=rs-06-q4 xp=10
After adding `"csp": "default-src 'self'"` to ClipDesk, every `invoke()` fails, while static
images and scripts still load. What's missing?
- [ ] `script-src 'unsafe-eval'`, because Tauri evaluates IPC responses.
- [x] A `connect-src` that allows the IPC protocol (`ipc:` and `http://ipc.localhost`).
- [ ] Nothing in the CSP; capabilities must also list `core:csp`.
- [ ] `frame-ancestors 'none'`.
> `invoke()` is a network-style request to Tauri's IPC protocol, so it falls under `connect-src`.
> `default-src 'self'` only covers your own origin. Never "fix" this with `unsafe-eval` or by
> removing the CSP.
:::

## The official plugins you'll use most

Tauri 2 keeps the core small; features live in plugins (`npm run tauri add <name>` adds the
crate, the JS package and a default permission). Each plugin has a `:default` set. Read what it
contains before relying on it.

| Plugin | What it gives you | Security notes |
|---|---|---|
| **opener** | open a URL in the browser, a file in its default app, reveal in file manager | `opener:default` allows `http(s)`, `mailto:` and `tel:` URLs and reveal-in-folder. Opening *paths* needs `opener:allow-open-path` with a scope. Replaces Tauri 1's `shell.open`. |
| **shell** | spawn programs and sidecars | nothing runs unless a scope entry names it; args are validated by fixed values or regexes |
| **dialog** | native open/save/message dialogs | the user picks the file, so it's the safest way to get a path |
| **fs** | read/write files from JS | scope tightly; `fs:default` covers only app-specific folders and denies the webview's data folder |
| **store** | persistent key/value JSON (settings) | lives in the app data dir; not a secrets vault |
| **http** | `fetch` from Rust (no CORS) | `http:default` allows no URL until you add a scope; keep it narrow, because a broad one like `https://*` lets the page reach any host with no CORS |
| **deep-link** | `clipdesk://open?clip=…` URLs | the URL is attacker-controlled input: parse and validate it |
| **single-instance** | second launch forwards args to the running app | register it **first**; with deep links enable its `deep-link` feature; no JS API, so no permissions |

```rust
// src-tauri/src/lib.rs: the order matters for single-instance
use tauri::Manager; // for get_webview_window

tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        // args come from a second launch, e.g. a deep link. Treat as untrusted input.
        let _ = app.get_webview_window("main").map(|w| w.set_focus());
        println!("second instance args: {args:?}");
    }))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_opener::init())
```

:::quiz id=rs-06-q5 xp=15
Which of these are real risks a reviewer should flag in ClipDesk's capabilities? (Select all that apply.)
- [x] `"shell:allow-execute"` with a scope entry `{ "name": "sh", "cmd": "sh", "args": true }`
- [x] `{ "identifier": "fs:allow-read-file", "allow": [{ "path": "$HOME/**" }] }` to "read the user's clips"
- [ ] `"opener:default"` in the main window
- [x] `"windows": ["*"]` on a capability that grants `allow-wipe-library`
- [ ] `"dialog:default"` in the main window
> `args: true` turns the webview into a remote shell. `$HOME/**` includes SSH keys and browser
> profiles. A `"*"` capability leaks a dangerous command into every window, including future ones.
> `opener:default` (web/mail/tel URLs) and dialogs (the user chooses) are normal defaults.
:::

## Shell and sidecars: running external programs safely

ClipDesk probes clips with a helper CLI. Bundling a binary next to your app is a **sidecar**.
Three pieces:

**1. Config.** List it under `bundle.externalBin` (path relative to `src-tauri`):

```json
{ "bundle": { "externalBin": ["binaries/clip-probe"] } }
```

**2. One file per target triple.** Tauri picks the binary built for the target it compiles for,
so the file name must end in that **target triple**:

```bash
rustc --print host-tuple          # Rust 1.84+; e.g. x86_64-unknown-linux-gnu
```

```text
src-tauri/binaries/
  clip-probe-x86_64-unknown-linux-gnu
  clip-probe-aarch64-apple-darwin
  clip-probe-x86_64-apple-darwin
  clip-probe-x86_64-pc-windows-msvc.exe
```

If the file for the current target is missing, the build fails. CI must build or download each
triple before `tauri build` (**Shipping: bundles, signing, auto-update and CI** covers this).

**3. Permission with validated args.** For calls from JavaScript, the shell scope must name the
sidecar and describe its arguments:

```json
{
  "identifier": "shell:allow-execute",
  "allow": [
    {
      "name": "binaries/clip-probe",
      "sidecar": true,
      "args": ["--info", { "validator": "[^-].*\\.(mp4|mov|mkv|webm)" }]
    }
  ]
}
```

- A **string** is a fixed argument. Tauri always passes that exact value in that position,
  whatever the caller sent there.
- `{ "validator": "…" }` is a regex the caller's value must match, or the call is rejected. Tauri
  anchors it by pasting it into `^{validator}$` unless you add `"raw": true`. That is a plain
  paste, so put alternatives in a group: `mp4|mov` would become `^mp4|mov$`; write `(mp4|mov)`.
- The list sets the argument count: a missing validated argument is an error, and extra arguments
  beyond the list are dropped.
- `"args": true` allows **any** arguments. `"args": false` (the default) runs the program with no
  arguments at all.
- Arguments are passed straight to the program with no shell, so `;` and `$(…)` mean nothing.
  The danger is the **program's own options**: a value like `--output=/etc/…` or `-o …` is an
  argument injection, which is why the validator above refuses a leading `-`.

From Rust you start it with the `ShellExt` trait:

```rust
use tauri_plugin_shell::ShellExt;

let output = app
    .shell()
    .sidecar("clip-probe")          // the file name only, not "binaries/clip-probe"
    .map_err(|e| e.to_string())?
    .args(["--info", path.as_str()])
    .output()
    .await
    .map_err(|e| e.to_string())?;
```

:::warn title="Rust calls skip the shell scope"
The shell scope checks calls that come **from the webview**. `app.shell().sidecar(...)` in your own
Rust command is trusted code and doesn't consult it. If a command passes a webview-supplied string
to a sidecar, **you** validate it in Rust. The lab does exactly that.
:::

:::quiz id=rs-06-q6 xp=10
`externalBin` is `["binaries/clip-probe"]`. A teammate builds on an Apple Silicon Mac. Which file
must exist?
- [ ] `src-tauri/binaries/clip-probe`
- [ ] `src-tauri/binaries/clip-probe-macos`
- [x] `src-tauri/binaries/clip-probe-aarch64-apple-darwin`
- [ ] `src-tauri/binaries/aarch64-apple-darwin/clip-probe`
> Each sidecar needs a copy named `<name>-<target triple>` (with `.exe` on Windows). Tauri strips
> the suffix when bundling, so in the installed app it's just `clip-probe`.
:::

Model the shell scope's argument check in TypeScript. Your version is **stricter** than Tauri's:
where Tauri silently substitutes fixed values and drops extra arguments, yours rejects the call.
That strict style is what you want in your own Rust validators, where nothing fills in the gaps.

:::challenge id=rs-06-c2 lang=ts xp=50
title: Validate sidecar arguments like the shell scope
Write `checkShellCall(scope, name, args)` that returns `null` when the call is allowed, or an error
string otherwise. `scope` is a list of entries `{ name, sidecar?, args? }`:

- No entry with that `name` → `"program not allowed"`.
- `args` is `true` → any arguments are fine.
- `args` is `false` or missing → only an empty `args` list is allowed, else `"arguments not allowed"`.
- `args` is a list → the call must have **exactly** as many arguments. A string must match exactly.
  `{ validator, raw? }` is a regex: anchor it as `^(?:validator)$` unless `raw` is `true`.
  The first failing position `i` returns `"argument i failed validation"`.
  A length mismatch returns `"wrong number of arguments"`.

hint: Find the entry with `scope.find(e => e.name === name)`.
hint: `typeof spec === 'string'` separates fixed args from validators.
hint: Without anchoring, `"\\S+"` would happily match `"--evil ok"` because it finds a non-space somewhere.

```ts starter
type ArgSpec = string | { validator: string; raw?: boolean }
interface ShellScopeEntry { name: string; sidecar?: boolean; args?: boolean | ArgSpec[] }

export function checkShellCall(scope: ShellScopeEntry[], name: string, args: string[]): string | null {
  // TODO
  return null
}
```

```ts solution
type ArgSpec = string | { validator: string; raw?: boolean }
interface ShellScopeEntry { name: string; sidecar?: boolean; args?: boolean | ArgSpec[] }

export function checkShellCall(scope: ShellScopeEntry[], name: string, args: string[]): string | null {
  const entry = scope.find(e => e.name === name)
  if (!entry) return 'program not allowed'
  const spec = entry.args ?? false
  if (spec === true) return null
  if (spec === false) return args.length === 0 ? null : 'arguments not allowed'
  if (spec.length !== args.length) return 'wrong number of arguments'
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i]
    if (typeof s === 'string') {
      if (s !== args[i]) return `argument ${i} failed validation`
    } else {
      const re = new RegExp(s.raw ? s.validator : `^(?:${s.validator})$`)
      if (!re.test(args[i])) return `argument ${i} failed validation`
    }
  }
  return null
}
```

```ts tests
const scope = [
  { name: 'binaries/clip-probe', sidecar: true, args: ['--info', { validator: '[^-].*\\.(mp4|mov|mkv|webm)' }] },
  { name: 'version', args: false },
  { name: 'anything', args: true },
  { name: 'loose', args: [{ validator: 'ok', raw: true }] },
]

test('a valid call passes', () => {
  expect(checkShellCall(scope, 'binaries/clip-probe', ['--info', '/home/me/Videos/a.mp4'])).toBeNull()
})
test('unknown programs are rejected', () => {
  expect(checkShellCall(scope, 'sh', ['-c', 'rm -rf ~'])).toBe('program not allowed')
})
test('fixed arguments must match exactly', () => {
  expect(checkShellCall(scope, 'binaries/clip-probe', ['--delete', '/home/me/a.mp4'])).toBe('argument 0 failed validation')
})
test('validators are anchored', () => {
  expect(checkShellCall(scope, 'binaries/clip-probe', ['--info', '/home/me/a.mp4 --overwrite'])).toBe('argument 1 failed validation')
  expect(checkShellCall(scope, 'binaries/clip-probe', ['--info', '--output=/etc/x.mp4'])).toBe('argument 1 failed validation')
})
test('the number of arguments must match', () => {
  expect(checkShellCall(scope, 'binaries/clip-probe', ['--info'])).toBe('wrong number of arguments')
  expect(checkShellCall(scope, 'binaries/clip-probe', ['--info', '/a.mp4', '/b.mp4'])).toBe('wrong number of arguments')
})
test('args false (or missing) allows only no arguments', () => {
  expect(checkShellCall(scope, 'version', [])).toBeNull()
  expect(checkShellCall(scope, 'version', ['--help'])).toBe('arguments not allowed')
})
test('args true allows anything', () => {
  expect(checkShellCall(scope, 'anything', ['--literally', 'anything'])).toBeNull()
})
test('raw validators are not anchored', () => {
  expect(checkShellCall(scope, 'loose', ['this is not ok?'])).toBeNull()
})
```
:::

## Writing your own plugin and permissions

When a feature grows (say, ClipDesk's "library" with list, probe, tag and delete), move it into a
plugin crate. A plugin declares its commands in its `build.rs`, and Tauri generates
`allow-`/`deny-` permissions for each:

```toml
# tauri-plugin-library/Cargo.toml (the parts that matter)
[package]
name = "tauri-plugin-library"
links = "tauri-plugin-library"   # required: tauri-plugin's build step refuses to run without it

[dependencies]
tauri = "2"

[build-dependencies]
tauri-plugin = { version = "2", features = ["build"] }
```

```rust
// tauri-plugin-library/build.rs
const COMMANDS: &[&str] = &["list_clips", "probe_clip", "tag_clip", "delete_clip"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
```

```toml
# tauri-plugin-library/permissions/default.toml
[default]
description = "Read-only library access. Tagging and deleting must be granted explicitly."
permissions = ["allow-list-clips", "allow-probe-clip"]
```

```rust
// tauri-plugin-library/src/lib.rs
use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

#[tauri::command]
async fn list_clips() -> Result<Vec<String>, String> { Ok(vec![]) }
// ... probe_clip, tag_clip, delete_clip

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library")
        .invoke_handler(tauri::generate_handler![list_clips /* , ... */])
        .build()
}
```

The app then grants `library:default` to the main window and `library:allow-delete-clip` only to
a confirmation window. From JS the commands are called as `invoke('plugin:library|list_clips')`
(usually wrapped in a small TS API module). If your plugin has a scope (folders it may touch), read
it in the command through the `CommandScope<T>` / `GlobalScope<T>` extractors and **enforce it
there**. The ACL only hands you the scope; checking it is your command's job.

:::job title="What you'll see at work"
Security review of a Tauri app is mostly a review of `src-tauri/capabilities/*.json` and of the
commands that take paths, URLs or arguments. Expect questions like "why does this window need
`fs:allow-write-file`?" and "where is this path validated?". Teams keep one capability per window
role, keep `gen/schemas` out of git (it's generated; the template's `.gitignore` already does this), and add a test or CI check that fails if a
capability grows (for example, diffing the resolved ACL in `src-tauri/gen/schemas/capabilities.json`).
:::

## Rust checkpoints

Writing the validator and command in the lab is ordinary Rust, and the compiler will stop you in
two places.

:::quiz id=rs-06-q7 xp=10
Will this compile?

```rust
pub fn validate_clip_path(raw: &str) -> Result<String, String> {
    if raw.starts_with('-') {
        return Err("path must not start with '-'");
    }
    Ok(raw.to_string())
}
```
- [ ] Yes: `&str` converts to `String` automatically.
- [x] No: error E0308 (mismatched types). `Err` needs a `String`, it got a `&'static str`. Write `"…".into()` or `.to_string()`.
- [ ] No: error E0106 (missing lifetime specifier) on `raw`.
- [ ] No: error E0382 (use of moved value) on `raw`.
> Rust never converts types silently in a constructor like `Err(...)`. Only the `?` operator calls
> `From::from` on the error for you: `.ok_or("no extension")?` *does* compile in a function returning
> `Result<String, String>`, because `String: From<&str>`.
:::

:::quiz id=rs-06-q8 xp=10
To test commands with a mock runtime, ClipDesk builds the app through a generic helper. Which
error do you get?

```rust
#[tauri::command]
async fn probe_clip(app: tauri::AppHandle, path: String) -> Result<String, String> { todo!() }

pub fn app_builder<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b.invoke_handler(tauri::generate_handler![probe_clip])
}
```
- [ ] It compiles; `AppHandle` adapts to any runtime.
- [x] E0277: the trait bound `AppHandle: CommandArg<'_, R>` is not satisfied. Make the command generic: `probe_clip<R: tauri::Runtime>(app: tauri::AppHandle<R>, …)`.
- [ ] E0599: no method `invoke_handler` on `Builder<R>`.
- [ ] E0433: failed to resolve `tauri::command`.
> `tauri::AppHandle` without a parameter means `AppHandle<Wry>`, the real webview runtime. The
> handler is being registered on `Builder<R>` for *any* `R` (including `MockRuntime` in tests), so
> the command must accept `AppHandle<R>` too. E0277 is "a trait bound isn't satisfied", and here the
> trait is the one Tauri uses to extract command arguments.
:::

:::cards id=rs-06-cards1 xp=15 title="Tauri 2 security"
Q: What's the difference between a permission and a capability?
A: A permission says which commands (and scopes) are allowed or denied. A capability grants a list
   of permissions to window/webview labels, optionally per platform and for remote URLs.
Q: What happens to a command no capability grants?
A: It's rejected (default deny). For app commands this holds once they're listed in
   `AppManifest::commands`; before that, app commands are open to every local window.
Q: Allow vs deny: which wins?
A: Deny. A `deny-…` permission beats an `allow-…`, and a scope deny entry beats a scope allow entry.
Q: A window matches two capabilities. What does it get?
A: The union of both. There is no "most specific wins".
Q: What do capabilities NOT protect against?
A: Bugs in your Rust commands (missing validation), lax scopes, Rust code that bypasses checks,
   webview 0-days and supply-chain compromise.
Q: How must a sidecar file be named?
A: `<name>-<target triple>`, e.g. `clip-probe-x86_64-pc-windows-msvc.exe`. Find the triple with
   `rustc --print host-tuple`.
Q: What does `"args": true` mean in a shell scope?
A: Any arguments are allowed. Almost always a mistake; list fixed args and regex validators instead.
Q: Which CSP directive keeps `invoke()` working?
A: `connect-src ipc: http://ipc.localhost`.
:::

## Lab: lock down ClipDesk

:::lab id=rs-06-lab1 xp=120
title: Capabilities, a validated sidecar, and a test that the forbidden call is rejected
You'll build ClipDesk's core: a `probe_clip` command that validates its input and then runs a
bundled sidecar, a dangerous `wipe_library` command that **no window is granted**, a capability for
the `main` window only, and `cargo test` tests that drive the real ACL through Tauri's mock runtime.

**Prerequisites:** Rust stable (1.90+, edition 2024), Node 20+, and the Tauri system dependencies
for your OS from the Tauri prerequisites page (WebView2 on Windows, Xcode CLT on macOS,
`webkit2gtk-4.1` and friends on Linux). Check with `rustc --version` and `node --version`.

**1. Create the app and the sidecar crate**

```bash
npm create tauri-app@latest clipdesk -- --template vanilla-ts --manager npm --identifier com.example.clipdesk --yes
cd clipdesk
npm install
npm install @tauri-apps/plugin-shell
cd src-tauri && cargo add tauri-plugin-shell && cd ..
cargo new --bin clip-probe
```

:::info
If your `create-tauri-app` version doesn't accept the flags, run `npm create tauri-app@latest`
and answer the questions: name `clipdesk`, identifier `com.example.clipdesk`, TypeScript/JavaScript,
npm, Vanilla, TypeScript. The template already includes the opener plugin.
:::

**2. The sidecar** (`clip-probe/src/main.rs`): prints a file's size as JSON.

```rust
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag, path] if flag == "--info" => match std::fs::metadata(path) {
            Ok(meta) => {
                println!("{{\"path\":{:?},\"bytes\":{}}}", path, meta.len());
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("clip-probe: cannot read {path}: {e}");
                ExitCode::from(2)
            }
        },
        _ => {
            eprintln!("usage: clip-probe --info <file>");
            ExitCode::from(64)
        }
    }
}
```

Build it and copy it in with the target-triple suffix:

```bash
cargo build --release --manifest-path clip-probe/Cargo.toml
mkdir -p src-tauri/binaries
cp clip-probe/target/release/clip-probe "src-tauri/binaries/clip-probe-$(rustc --print host-tuple)"
```

On Windows PowerShell:

```powershell
cargo build --release --manifest-path clip-probe/Cargo.toml
New-Item -ItemType Directory -Force src-tauri/binaries
Copy-Item clip-probe/target/release/clip-probe.exe "src-tauri/binaries/clip-probe-$(rustc --print host-tuple).exe"
```

**3. `src-tauri/Cargo.toml`** (replace the `[dependencies]` sections; keep your template's
`[package]` and `[lib]`, which should look like this):

```toml
[package]
name = "clipdesk"
version = "0.1.0"
edition = "2024"

[lib]
name = "clipdesk_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
tauri = { version = "2", features = ["test"] }
```

The `test` feature only for dev-dependencies gives you `tauri::test` (mock runtime) in `cargo test`
without shipping it.

**4. `src-tauri/build.rs`**: put the app's commands behind the ACL.

```rust
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            // Listing app commands here turns on the ACL for them:
            // each gets an `allow-<name>` / `deny-<name>` permission, and none is granted by default.
            tauri_build::AppManifest::new().commands(&["probe_clip", "wipe_library"]),
        ),
    )
    .expect("failed to run tauri-build");
}
```

**5. Capabilities.** Delete `src-tauri/capabilities/default.json` and create
`src-tauri/capabilities/main-window.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-window",
  "description": "What the main ClipDesk window may do - and nothing more",
  "windows": ["main"],
  "platforms": ["linux", "macOS", "windows"],
  "permissions": [
    "core:default",
    "opener:default",
    "allow-probe-clip",
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "binaries/clip-probe",
          "sidecar": true,
          "args": ["--info", { "validator": "[^-].*\\.(mp4|mov|mkv|webm)" }]
        }
      ]
    }
  ]
}
```

Notice what's **not** there: `allow-wipe-library`, any `fs:` permission, any `"*"` window.

**6. `src-tauri/tauri.conf.json`**: keep your template's `bundle.icon` list; the rest:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "ClipDesk",
  "version": "0.1.0",
  "identifier": "com.example.clipdesk",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      { "label": "main", "title": "ClipDesk", "width": 900, "height": 600 }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data:; object-src 'none'; base-uri 'none'",
      "devCsp": "default-src 'self'; connect-src ipc: http://ipc.localhost ws://localhost:1420; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
      "freezePrototype": true
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "externalBin": ["binaries/clip-probe"]
  }
}
```

**7. `src-tauri/src/lib.rs`**: the commands, the validator and the tests. Replace the whole file
(`main.rs` from the template already calls `clipdesk_lib::run()`).

```rust
use std::path::Path;
use tauri_plugin_shell::ShellExt;

const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "mkv", "webm"];

/// Everything the webview sends is untrusted input. Check it here, in Rust,
/// before it gets anywhere near a process. (The shell scope in the capability
/// only guards calls made from JavaScript - Rust calls to `sidecar()` skip it.)
pub fn validate_clip_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("path is empty".into());
    }
    if raw.starts_with('-') {
        return Err("path must not start with '-'".into());
    }
    if raw.contains('\0') {
        return Err("path contains a NUL byte".into());
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("path must not contain '..'".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or("path has no extension")?;
    if !VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("'.{ext}' is not a video file"));
    }
    Ok(raw.to_string())
}

#[tauri::command]
async fn probe_clip<R: tauri::Runtime>(app: tauri::AppHandle<R>, path: String) -> Result<String, String> {
    let path = validate_clip_path(&path)?;
    let output = app
        .shell()
        .sidecar("clip-probe")
        .map_err(|e| e.to_string())?
        .args(["--info", path.as_str()])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A dangerous command that is registered but granted to no window.
#[tauri::command]
fn wipe_library() -> String {
    "library wiped".into()
}

pub fn app_builder<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![probe_clip, wipe_library])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running ClipDesk");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
    use tauri::webview::InvokeRequest;
    use tauri::{Manager, WebviewWindowBuilder};

    // The URL your bundled frontend is served from: tauri://localhost on macOS/Linux/iOS,
    // http://tauri.localhost on Windows and Android.
    const LOCAL_URL: &str = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };

    fn call(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        body: serde_json::Value,
        url: &str,
    ) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: url.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    fn text(err: serde_json::Value) -> String {
        err.as_str().map(str::to_owned).unwrap_or_else(|| err.to_string())
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        app_builder(mock_builder())
            .build(tauri::generate_context!())
            .expect("failed to build the test app")
    }

    fn window(app: &tauri::App<tauri::test::MockRuntime>, label: &str) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        app.get_webview_window(label).unwrap_or_else(|| {
            WebviewWindowBuilder::new(app, label, Default::default()).build().unwrap()
        })
    }

    #[test]
    fn validator_accepts_a_video_path() {
        let p = if cfg!(windows) { r"C:\clips\intro.MP4" } else { "/home/me/clips/intro.MP4" };
        assert_eq!(validate_clip_path(p), Ok(p.to_string()));
    }

    #[test]
    fn validator_rejects_flags_relative_paths_and_other_files() {
        assert!(validate_clip_path("--help").is_err());
        assert!(validate_clip_path("clips/intro.mp4").is_err());
        assert!(validate_clip_path("/home/me/../../etc/passwd.mp4").is_err());
        assert!(validate_clip_path("/home/me/.ssh/id_ed25519").is_err());
        assert!(validate_clip_path("").is_err());
    }

    #[test]
    fn main_window_may_not_wipe_the_library() {
        let app = app();
        let main = window(&app, "main");
        let err = call(&main, "wipe_library", serde_json::json!({}), LOCAL_URL).unwrap_err();
        assert!(text(err).contains("wipe_library not allowed"));
    }

    #[test]
    fn main_window_reaches_probe_clip_and_the_validator_runs() {
        let app = app();
        let main = window(&app, "main");
        // The ACL lets the call through; our own validator then rejects the argument.
        let err = call(&main, "probe_clip", serde_json::json!({ "path": "--help" }), LOCAL_URL).unwrap_err();
        assert_eq!(text(err), "path must not start with '-'");
    }

    #[test]
    fn other_windows_get_nothing() {
        let app = app();
        let preview = window(&app, "preview");
        let err = call(&preview, "probe_clip", serde_json::json!({ "path": "/x/a.mp4" }), LOCAL_URL).unwrap_err();
        assert!(text(err).contains(r#"not allowed on window "preview""#));
    }

    #[test]
    fn a_remote_page_in_the_main_window_gets_nothing() {
        let app = app();
        let main = window(&app, "main");
        let err = call(&main, "probe_clip", serde_json::json!({ "path": "/x/a.mp4" }), "https://evil.example/").unwrap_err();
        let msg = text(err);
        assert!(msg.contains("not allowed"), "{msg}");
    }
}
```

Why the tests are written this way:

- `generate_context!()` compiles in **your real** `tauri.conf.json` and capabilities, so the mock app
  enforces exactly the ACL you ship. `mock_context()` would give an empty ACL and prove nothing.
- `main_window_reaches_probe_clip_and_the_validator_runs` passes `"--help"` so the call gets past the
  ACL but stops at **your** validator, without needing the sidecar during tests.
- The `url` matters. A call from `https://evil.example/` is a *remote* origin, and there is no
  `remote.urls` in the capability.

**8. The frontend.** Replace `index.html` and `src/main.ts`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ClipDesk</title>
    <script type="module" src="/src/main.ts"></script>
  </head>
  <body>
    <main>
      <h1>ClipDesk</h1>
      <input id="path" placeholder="/full/path/to/clip.mp4" size="60" />
      <button id="probe">Probe (Rust command)</button>
      <button id="probe-js">Probe (sidecar from JS)</button>
      <button id="wipe">Wipe library</button>
      <pre id="out"></pre>
    </main>
  </body>
</html>
```

```ts
import { invoke } from '@tauri-apps/api/core'
import { Command } from '@tauri-apps/plugin-shell'

const out = document.querySelector<HTMLPreElement>('#out')!
const input = document.querySelector<HTMLInputElement>('#path')!

function show(label: string, value: unknown) {
  out.textContent = `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
}

window.addEventListener('DOMContentLoaded', () => {
  document.querySelector('#probe')!.addEventListener('click', async () => {
    try { show('probe_clip', await invoke<string>('probe_clip', { path: input.value })) }
    catch (e) { show('probe_clip rejected', e) }
  })
  document.querySelector('#probe-js')!.addEventListener('click', async () => {
    try {
      const r = await Command.sidecar('binaries/clip-probe', ['--info', input.value]).execute()
      show('sidecar via JS', r.stdout || r.stderr)
    } catch (e) { show('sidecar via JS rejected', e) }
  })
  document.querySelector('#wipe')!.addEventListener('click', async () => {
    try { show('wipe_library', await invoke('wipe_library')) }
    catch (e) { show('wipe_library rejected', e) }
  })
})
```

**9. Run the tests.** `generate_context!` needs `dist/` to exist, so build the frontend once:

```bash
npm run build
cd src-tauri
cargo test
```

Expected for the `clipdesk_lib` unit tests (order may vary; cargo also prints empty runs for
`main.rs` and the doc-tests):

```text
running 6 tests
test tests::validator_accepts_a_video_path ... ok
test tests::validator_rejects_flags_relative_paths_and_other_files ... ok
test tests::other_windows_get_nothing ... ok
test tests::a_remote_page_in_the_main_window_gets_nothing ... ok
test tests::main_window_may_not_wipe_the_library ... ok
test tests::main_window_reaches_probe_clip_and_the_validator_runs ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

**10. Prove the tests guard the ACL.** Add `"allow-wipe-library"` to `main-window.json`, run
`cargo test` again and watch `main_window_may_not_wipe_the_library` fail. Remove it. Then change
`"windows": ["main"]` to `["*"]` and watch `other_windows_get_nothing` fail. Change it back.

**11. Try it for real.** `npm run tauri dev` from the project root, then:

| Input | Button | Expected output |
|---|---|---|
| full path of any `.mp4` on your disk | Probe (Rust command) | `probe_clip: {"path":"…","bytes":…}` |
| `--help` | Probe (Rust command) | `probe_clip rejected: path must not start with '-'` |
| `/etc/hosts` (or `C:\Windows\win.ini`) | Probe (sidecar from JS) | rejected: `… failed regex validation …` |
| anything | Wipe library | `wipe_library rejected: wipe_library not allowed. …` |

:::tip
If **every** call fails with a CSP message in the devtools console (right-click > Inspect), compare
your `connect-src` with step 6. If the build complains about `binaries/clip-probe-<triple>`, step 2's
file name doesn't match `rustc --print host-tuple`.
:::

- [ ] `cargo test` in `src-tauri` reports 6 passed
- [ ] Granting `allow-wipe-library` (or widening `windows` to `"*"`) makes a test fail, and reverting fixes it
- [ ] In `npm run tauri dev`, probing a real `.mp4` through the Rust command prints its size
- [ ] `--help` is rejected by your validator and `/etc/hosts` is rejected by the shell scope
- [ ] Clicking "Wipe library" shows the ACL's "not allowed" error
:::

## How it breaks in practice

- **"It worked in Tauri 1."** Copying `allowlist` config or `@tauri-apps/api/tauri` imports from an old
  tutorial. Tauri 2 ignores or rejects them; port to capabilities and `@tauri-apps/api/core`.
- **App commands left open.** Nobody listed them in `AppManifest::commands`, so every local window
  (including a future "help" window rendering markdown) can call `delete_clip`.
- **The `"*"` capability.** Someone adds `"windows": ["*"]` to make a new window work. It quietly
  grants everything in that file to every window, now and later.
- **`shell:allow-execute` with `sh -c` or `args: true`.** That's a remote shell for any XSS. Name the
  exact program and validate each argument; prefer a Rust command that builds the arguments itself.
- **Unanchored or loose validators.** `"raw": true` with `"\\S+"`, or a validator that allows a
  leading `-`, invites argument injection (`--output=…`).
- **Overly broad fs scopes.** `$HOME/**` "to read the user's videos" also covers SSH keys and browser
  profiles. Use the dialog plugin and specific folders like `$VIDEO/ClipDesk/**`.
- **Trusting the scope in Rust.** Rust-side `sidecar()`/`std::fs` calls don't check capabilities.
  Validate every webview-supplied value in the command.
- **Remote content with local powers.** Loading a remote page into a window that has a capability
  with `remote.urls: ["https://*"]`. On Linux and Android Tauri can't tell an `<iframe>` from the
  window itself, so an embedded third-party frame may inherit the grant.
- **CSP removed "to fix it".** `invoke()` broke, so someone deletes the CSP. Add the IPC origins to
  `connect-src` instead.
- **Sidecar missing in CI.** `externalBin` is set but the `-<target-triple>` file only exists on a
  developer's laptop; the release build fails on the other runners.
- **Unvalidated deep links.** `clipdesk://open?clip=../../.ssh/id_ed25519` arrives through deep-link or
  single-instance args and goes straight into a file read.

:::pro title="A review checklist seniors actually use"
1. One capability per window role; no dangerous permission in a `"*"` capability.
2. All app commands in `AppManifest::commands`.
3. No `args: true`, no `sh`/`cmd`/`powershell` in shell scopes; validators reject leading `-`.
4. fs/http/opener scopes are as narrow as the feature; deny entries for secrets.
5. Every command that takes a path/URL/argument validates it in Rust, with unit tests.
6. CSP set, no `unsafe-eval`, `freezePrototype` on.
7. A test that a forbidden call is rejected, so a capability change shows up in CI.
:::

## Recap

- The webview is the untrusted side of an IPC trust boundary. A compromised page can do exactly
  what its window was granted, so grant little.
- **Permissions** allow/deny commands and carry **scopes**; **sets** group them; **capabilities**
  grant them to window labels, per platform, and (only if you say so) to remote URLs.
- Default deny, deny beats allow, overlapping capabilities merge. App commands join the ACL once you
  list them in `AppManifest::commands`.
- Scope everything that takes a path, URL or program; avoid `$HOME/**`, `"*"` windows and `args: true`.
- Set a CSP with `connect-src ipc: http://ipc.localhost`, and turn on `freezePrototype`.
- Know the main plugins: opener, shell, dialog, fs, store, http, deep-link, single-instance (registered first).
- Sidecars: `bundle.externalBin`, one `<name>-<target-triple>` file per target, a shell scope with
  fixed args and anchored validators for JS, and your own validation for Rust-side calls.
- Prove it with tests: build the app with `mock_builder()` and the real `generate_context!()`, then
  assert that the forbidden `invoke` is rejected.

Next, **One app, every platform: Windows, macOS, Linux, Android, iOS** uses `platforms` in
capabilities for real, with mobile-only plugins and per-OS differences.
