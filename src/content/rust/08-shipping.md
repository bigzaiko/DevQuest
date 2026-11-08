---
id: rs-08
title: "Shipping: bundles, signing, auto-update and CI"
level: advanced
minutes: 120
xp: 200
summary: Turn a Tauri 2 app into signed installers for every OS, wire up the signed updater with latest.json, and let a GitHub Actions matrix build and publish each release.
---

Your app works on your machine. That's step one of about ten. ClipDesk is the small media-tool desktop
app this region has been building. Before a stranger can use it, four things have to be true:

1. **There is an installer they recognise.** A `.msi` or `setup.exe` on Windows, a `.dmg` on macOS,
   an AppImage, `.deb` or `.rpm` on Linux, and an APK/AAB or IPA on phones.
2. **The OS trusts it.** Without a code signature, Windows SmartScreen shows "Windows protected
   your PC", macOS Gatekeeper says the app "cannot be opened", and Smart App Control on Windows 11
   may block it outright.
3. **It can update itself, safely.** If an attacker takes over your download server, they must not
   be able to push malware to every install.
4. **Releases are boring.** One tag push builds every platform on clean machines, with secrets that
   live in CI and not on a laptop.

This lesson covers all four. **One App, Every Platform** (rs-07) showed how to *build* for each OS.
This lesson is about *shipping*: signing, updating and automating. The security model from
**Tauri Security: capabilities, permissions and plugins** (rs-06) comes back here too, because the
updater is a plugin that needs permissions.

:::info title="Words you'll meet in this lesson"
- **Bundle**: the platform-specific package around your binary (MSI, NSIS setup.exe, .app/.dmg,
  AppImage, .deb, .rpm, APK/AAB, IPA). Tauri's bundler makes them in `src-tauri/target/release/bundle/`.
- **Code signing**: a signature from a certificate the OS trusts, attached to your binary or installer.
  It proves who published the file and that nobody changed it since.
- **Notarization** (macOS): Apple scans your signed app and returns a "ticket". Gatekeeper wants that
  ticket before it opens apps downloaded from the internet.
- **Stapling**: attaching the notarization ticket to the `.app`/`.dmg`, so the check also works offline.
- **Updater signature**: a *separate* signature, made with a Tauri keypair you generate yourself.
  The updater plugin refuses any download that doesn't match your public key.
- **`latest.json`**: the static manifest the updater downloads. It holds the new version, and a URL
  and signature for each platform.
- **Platform key**: `OS-ARCH`, for example `windows-x86_64`, `darwin-aarch64` or `linux-x86_64`.
:::

## Why shipping is its own skill

On the web, "deploy" means you replace files on a server and every user gets the new version on the
next page load. Desktop apps are different: **every install is a copy you no longer control**.
A bug you ship stays on users' machines until *they* update. A broken update can take away your only
way of fixing it.

```text
  web app                              desktop app
  ───────                              ───────────
  you ──deploy──▶ server ◀── users     you ──release──▶ GitHub Releases ──▶ 10 000 installs
  one copy, you control it                               each one: its own version, its own
  rollback = redeploy                                    OS, its own update schedule
                                                         rollback = ship a NEWER version
```

So shipping a desktop app comes down to **trust** (signing) and **reach** (updates). Get both
right before your first public release. Retrofitting an updater means asking every early user to
reinstall by hand.

:::job title="What you'll see at work"
A desktop team usually has a `release.yml` that nobody likes to touch, a signing certificate that
expires at the worst moment, and one person who knows the Apple notarization password. Your first
release tasks are likely to be: bump the version in one place, push a tag, watch the matrix go green,
check the draft release, and click **Publish**. If you can explain *why* each step exists, you'll be
the person they hand the release process to.
:::

## Bundles per OS

Tauri's bundler reads `bundle` in `src-tauri/tauri.conf.json`. `"targets": "all"` (the default) builds
every format the *current* OS can make. You can also list them: `deb`, `rpm`, `appimage`, `msi`,
`nsis`, `app`, `dmg`.

| OS | Formats | Built on | Notes |
| --- | --- | --- | --- |
| Windows | `.msi` (WiX), `-setup.exe` (NSIS) | Windows (MSI only there) | NSIS installs per-user into `%LOCALAPPDATA%` by default, no admin needed. MSI is what IT departments deploy with group policy and Intune. |
| macOS | `.app`, `.dmg` | macOS only | Intel (`x86_64-apple-darwin`), Apple silicon (`aarch64-apple-darwin`), or one `universal-apple-darwin` binary that holds both. |
| Linux | AppImage, `.deb`, `.rpm` | Linux | AppImage runs anywhere and can self-update. `.deb`/`.rpm` go through the system package manager. |
| Android | APK, AAB | any OS with the Android SDK | The Play Store wants an AAB. APKs are for sideloading. See rs-07. |
| iOS | IPA | macOS with Xcode | Distributed through the App Store or TestFlight. See rs-07. |

```bash
npm run tauri build                                    # all formats for this OS
npm run tauri build -- --bundles nsis                  # just setup.exe
npm run tauri build -- --target universal-apple-darwin # one macOS build for both CPUs
npm run tauri android build                            # APK + AAB
npm run tauri ios build                                # IPA
```

The **updater plugin is desktop-only**. Phones get updates through their stores, which also handle
signing for you (Play App Signing, App Store distribution). The rest of this lesson is about the three
desktop OSes.

On Windows, the WebView2 runtime is a decision too. `bundle.windows.webviewInstallMode` can be
`downloadBootstrapper` (the default, needs internet during install), `embedBootstrapper`
(about 1.8 MB more), `offlineInstaller` (about 127 MB more, for air-gapped machines) or
`fixedVersion` (about 180 MB more, ships one WebView2 build with the app).

### Versioning: one source of truth

Tauri reads the version from the top-level `version` in `tauri.conf.json`. That value can also be a
path to a `package.json`. If it's missing, Tauri uses `Cargo.toml`. Choose **one** place and bump
only that, because the version feeds:

- the installer metadata (Windows "Apps & features", macOS `CFBundleShortVersionString`),
- the updater's comparison (`version` in `latest.json` must be **greater** than the installed one),
- the release tag in CI (`v__VERSION__` in tauri-action).

Use **SemVer** (`MAJOR.MINOR.PATCH[-pre][+build]`). One Windows-specific trap: an MSI version is
purely numeric, `major.minor.patch.build`, with major and minor at most **255** and the last two at
most **65 535**. `2026.11.8` breaks the major limit. A text pre-release such as `1.4.0-beta.2` can't
be expressed in an MSI version either: the bundler stops with an error that the pre-release identifier
must be numeric-only (a purely numeric one, such as `1.4.0-2`, is accepted and becomes the fourth
field). Either keep the app version MSI-friendly or set `bundle.windows.wix.version` explicitly.

:::quiz id=rs-08-q1 xp=10
ClipDesk's release workflow runs `npm run tauri build` on an `ubuntu-22.04` runner. Which bundles can
that job produce? (Select all that apply.)
- [x] AppImage
- [x] `.deb`
- [x] `.rpm`
- [ ] `.msi`
- [ ] `.dmg`
> Each OS builds its own native formats. MSI needs WiX, which only runs on Windows, and `.app`/`.dmg`
> need macOS tooling (and macOS signing needs Apple's `codesign`). That's why release pipelines use a
> **matrix** of Windows, macOS and Linux runners rather than cross-compiling everything from one box.
> NSIS can be cross-compiled from Linux, but Tauri's docs call that a last resort.
:::

## Code signing: making the OS trust you

Signing answers two questions the OS asks about every downloaded program: **who made this?** and
**has it been changed?** It does *not* say the app is safe. It says the app is *accountable*: if
it turns out to be malware, the certificate can be revoked and every copy stops being trusted.

### Windows: Authenticode and SmartScreen

Windows uses **Authenticode**: a signature embedded in the `.exe`/`.msi`, made with a code-signing
certificate from a CA (Certificate Authority) such as DigiCert or Sectigo, or from Microsoft's own
cloud service, **Azure Artifact Signing** (formerly Trusted Signing).

- Since June 2023, the private key for a publicly trusted code-signing certificate must live on
  **hardware** (a USB token or an HSM, a hardware security module) or in a cloud HSM. You can't just
  copy a `.pfx` file into CI any more. Cloud signing (Azure Key Vault, Azure Artifact Signing) is how
  most teams sign in CI today.
- **Timestamp** every signature (`timestampUrl`). Without a timestamp, the signature stops being
  valid when the certificate expires. With one, it stays valid.
- **SmartScreen reputation** is earned over time. A newly signed app can still show a warning
  until enough people have downloaded it. Since 2024, EV certificates no longer skip this. EV and OV
  certificates build reputation the same way.

Tauri signs Windows bundles itself if you configure it:

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "A1B2C3D4E5F6...",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

With a cloud signer you use `signCommand` instead. `%1` is the file Tauri wants signed:

```json
{ "bundle": { "windows": { "signCommand": "relic sign --file %1 --key azure --config relic.conf" } } }
```

Check a signature with `signtool verify /pa /v ClipDesk_1.4.0_x64-setup.exe`, or right-click the file
and open **Properties → Digital Signatures**.

### macOS: Developer ID, hardened runtime, notarization, stapling

Apple has a stricter chain. Every step is required for an app people download from the web:

```text
 Developer ID Application cert ──▶ codesign --options runtime ──▶ notarytool submit --wait
 (paid Apple Developer account)    (hardened runtime: no code     (Apple scans it, returns
                                    injection, no unsigned libs)    a ticket)
                                                                        │
                       user double-clicks ◀── stapler staple ◀──────────┘
                       Gatekeeper: OK         (ticket attached, works offline)
```

- **Developer ID Application** is the certificate for apps distributed *outside* the Mac App Store.
  "Apple Development" certificates only work on your own test devices.
- **Hardened runtime** is a codesign option that blocks code injection, unsigned dynamic libraries
  and debugger attachment. Notarization requires it. Tauri turns it on by default
  (`bundle.macOS.hardenedRuntime` is `true`).
- **Notarization**: you upload the signed app and Apple scans it. Tauri runs `xcrun notarytool` for
  you when it finds credentials in the environment: either `APPLE_ID` + `APPLE_PASSWORD` (an
  *app-specific* password) + `APPLE_TEAM_ID`, or an App Store Connect API key (`APPLE_API_KEY`,
  `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`). Free developer accounts can't notarize.
- **Stapling** attaches the ticket to the app, so Gatekeeper doesn't need to ask Apple online.

The signing identity comes from `bundle.macOS.signingIdentity` or `APPLE_SIGNING_IDENTITY`. In CI,
put the certificate in `APPLE_CERTIFICATE` (a base64-encoded `.p12` export) together with
`APPLE_CERTIFICATE_PASSWORD`. When both are set, Tauri's bundler imports the certificate into a
temporary keychain by itself (Tauri's docs also show an explicit `security import` step, which
does the same job by hand). `"signingIdentity": "-"` means **ad-hoc** signing. Ad-hoc is enough to
run the app on Apple silicon, but users still have to allow it by hand in **Privacy & Security**.

To check the result yourself:

```bash
codesign --verify --deep --strict --verbose=2 ClipDesk.app
xcrun stapler validate ClipDesk.dmg
spctl --assess --type open --context context:primary-signature -vvv ClipDesk.dmg
```

### Linux: signing is optional, repositories are the trust

Linux desktops don't check signatures when you double-click an AppImage. An AppImage can carry a
GPG signature, but almost nobody verifies it. On Linux, trust comes from **package repositories**:
an apt repo with a signed `Release` file, or an rpm repo whose packages are GPG-signed. If you
publish a repo, users add your key once and `apt upgrade`/`dnf upgrade` keep ClipDesk current.
Without a repo, the Tauri updater covers the AppImage, which is the Linux format Tauri's updater
docs describe. Recent versions of the updater plugin can also install a `.deb` or `.rpm` update
(they ask for an admin password, through `pkexec` for example), but test that path yourself before
you rely on it.

:::quiz id=rs-08-q2 xp=10
ClipDesk's `.dmg` is signed with a valid **Developer ID Application** certificate, but the build skipped
notarization. A user downloads it with Safari and double-clicks it. What happens, and what fixes it?
- [ ] It opens normally: a Developer ID signature is all Gatekeeper checks
- [x] Gatekeeper blocks it. Submit it with `notarytool` (with the hardened runtime on) and staple the ticket
- [ ] Gatekeeper blocks it. Re-sign it with an "Apple Development" certificate
- [ ] It opens, but only if the user runs it from Terminal with `sudo`
> Since macOS 10.15, software downloaded from the internet must be **notarized** as well as signed
> with Developer ID. Notarization requires the hardened runtime. Stapling attaches the ticket so the
> check also works offline. "Apple Development" certificates are for local testing only.
:::

:::quiz id=rs-08-q3 xp=10
Which statements about Windows code signing in 2026 are true? (Select all that apply.)
- [x] Publicly trusted code-signing keys must be stored on hardware or in a (cloud) HSM
- [x] A timestamp keeps the signature valid after the certificate expires
- [ ] An EV certificate skips SmartScreen warnings from the very first download
- [ ] Signing the MSI also signs the updater artifacts, so no Tauri keypair is needed
> Since June 2023 private keys must be on hardware or in an HSM, which is why CI usually signs through
> a cloud service. Timestamps make signatures outlive the certificate. Since 2024, EV certificates
> earn SmartScreen reputation like OV ones. Authenticode and the **Tauri updater signature** are two
> separate things: the updater only trusts the public key in your config.
:::

## The Tauri updater: signed updates from a static file

The updater plugin solves the "reach" problem. Its security rests on one idea: **downloads are only
installed if they're signed with your private key**. HTTPS protects the transfer, and your signature
protects the content. Even if someone takes over your GitHub account's release assets or your CDN,
they can't forge a signature without the private key.

```text
          your laptop / CI                         every installed ClipDesk
          ────────────────                         ────────────────────────
  tauri signer generate ──▶ private key ──┐        pubkey (baked into the app at build time)
                         └▶ public key ───┼───────────────────────────▲
                                          │                           │ verify
  tauri build + TAURI_SIGNING_PRIVATE_KEY │                           │
     ──▶ ClipDesk_1.4.0_x64-setup.exe     │                           │
     ──▶ ClipDesk_1.4.0_x64-setup.exe.sig ◀─ signed with private key ─┘
```

### 1. Generate the keypair

```bash
npm run tauri signer generate -- -w ~/.tauri/clipdesk.key
```

This writes `~/.tauri/clipdesk.key` (private, password-protected if you enter a password) and
`~/.tauri/clipdesk.key.pub`. At build time, Tauri reads the private key from
`TAURI_SIGNING_PRIVATE_KEY` (a path or the key's content) and the password from
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `.env` files are **not** read.

:::warn title="Lose this key and you lose your users"
Every installed copy only trusts the public key it was built with. If the private key is lost, you
**can't publish another update** to those installs. They have to download a new installer by hand.
Back the key up in two places (a password manager plus offline storage), and keep the password
separate from the key.
:::

### 2. Configure the plugin

```bash
npm run tauri add updater   # Rust crate + JS package + registers the plugin
npm run tauri add process   # for relaunch() after installing
```

```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IC4uLgo=",
      "endpoints": ["https://github.com/you/clipdesk/releases/latest/download/latest.json"],
      "windows": { "installMode": "passive" }
    }
  }
}
```

- `pubkey` is the **content** of `clipdesk.key.pub`, not a path.
- `endpoints` is an array that Tauri tries in order. URLs may contain `{{target}}` (`linux`,
  `windows`, `darwin`), `{{arch}}` (`x86_64`, `aarch64`, `i686`, `armv7`) and `{{current_version}}`
  for a dynamic server. Production builds require HTTPS.
- `createUpdaterArtifacts: true` makes `tauri build` write a `.sig` next to every updatable bundle:
  `ClipDesk.app.tar.gz` (macOS), `ClipDesk_1.4.0_amd64.AppImage` (Linux), and `-setup.exe` / `.msi`
  (Windows).
- On Windows, `installMode` is `passive` (a progress bar, the default), `basicUi` (the user clicks
  through) or `quiet` (no UI, needs admin or a per-user install).

The plugin is a capability-guarded plugin like any other (rs-06). Add `updater:default`, which allows
check, download and install, plus `process:allow-restart` to `src-tauri/capabilities/default.json`.

### 3. The `latest.json` format

```json
{
  "version": "1.4.0",
  "notes": "Faster trimming, new export presets",
  "pub_date": "2026-11-02T10:00:00Z",
  "platforms": {
    "darwin-aarch64": { "url": "https://github.com/you/clipdesk/releases/download/v1.4.0/ClipDesk_aarch64.app.tar.gz", "signature": "dW50cnVzdGVk..." },
    "darwin-x86_64":  { "url": "https://github.com/you/clipdesk/releases/download/v1.4.0/ClipDesk_x64.app.tar.gz",     "signature": "dW50cnVzdGVk..." },
    "linux-x86_64":   { "url": "https://github.com/you/clipdesk/releases/download/v1.4.0/ClipDesk_1.4.0_amd64.AppImage", "signature": "dW50cnVzdGVk..." },
    "windows-x86_64": { "url": "https://github.com/you/clipdesk/releases/download/v1.4.0/ClipDesk_1.4.0_x64-setup.exe", "signature": "dW50cnVzdGVk..." }
  }
}
```

Rules that bite:

- `version`, and each platform's `url` and `signature`, are **required**. `notes` and `pub_date`
  (RFC 3339) are optional. The version may have a leading `v`.
- `signature` is the **content of the `.sig` file**, not its path or URL.
- Tauri validates the **whole file** before it compares versions. One incomplete platform entry
  breaks the update check for *every* platform.
- Keys are `OS-ARCH`. If no key fits the running platform, an update that is newer fails with an
  error instead of installing. The plugin first looks for an installer-specific key
  (`OS-ARCH-installer`, such as `windows-x86_64-nsis` or `linux-x86_64-appimage`), then for the
  plain `OS-ARCH` key. tauri-action writes both kinds. Its plain `windows-x86_64` entry points to
  the `.msi` unless you set `updaterJsonPreferNsis: true` (the hand-written example above uses the
  `setup.exe`).

### 4. The update flow in the app

```ts
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export async function updateIfAvailable(onProgress: (pct: number) => void): Promise<void> {
  const update = await check()           // null when there's nothing newer
  if (!update) return
  if (!confirm(`ClipDesk ${update.version} is available.\n\n${update.body ?? ''}\n\nInstall now?`)) return
  let total = 0
  let done = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') total = event.data.contentLength ?? 0
    if (event.event === 'Progress') { done += event.data.chunkLength; if (total) onProgress(done / total) }
  })
  await relaunch()
}
```

```text
ClipDesk 1.3.2 starts
   │  GET …/releases/latest/download/latest.json
   ▼
parse + validate the WHOLE file ───invalid───▶ error (no update, on every OS)
   │
1.4.0 > 1.3.2 ? ───no───▶ nothing to do
   │ yes
platforms["windows-x86_64"] ───missing───▶ error
   │
download url ─▶ verify .sig with pubkey ───mismatch───▶ refuse, nothing installed
   │ ok
install (Windows: the app exits, the installer runs) ─▶ relaunch()
```

The same flow exists in Rust (`app.updater()?.check().await?`, then `update.download_and_install(...)`)
if you'd rather check from `setup()` or a background task (rs-04 covered tokio).
`app.updater_builder()` lets you change endpoints, headers, the timeout or the **version comparator**
at runtime.

### Rollback risks

The updater has **no automatic rollback**. By default it only moves to a *greater* version. So:

- **To "roll back", ship forward.** If 1.4.0 is broken, release 1.4.1 containing the 1.3.2 code.
  Clients on 1.4.0 accept it because 1.4.1 > 1.4.0.
- **Keep the update check outside the code you change most.** If 1.4.0 crashes during startup
  *before* it checks for updates, those users are stuck for good. Check early, in a small code path
  that a failed migration or a bad plugin can't take down.
- **Data moves forward too.** If 1.4.0 migrated the local database, a downgrade (allowed with a custom
  `version_comparator`) may open data it doesn't understand. Version your on-disk formats.
- **Pre-releases.** `1.5.0-beta.1` *is* greater than `1.4.0`. If it ends up in the stable
  `latest.json`, every stable user gets the beta. Use a separate endpoint (a beta channel) for
  pre-releases.

:::pro title="Staged rollouts"
A static `latest.json` updates everyone at once. Larger teams use a **dynamic endpoint**
(`https://updates.example.com/{{target}}/{{arch}}/{{current_version}}`) that returns `204 No Content`
for "no update" and can answer "yes" to only 5 % of installs first. Crash reports from that 5 %
decide whether the rest get it. The updater signature still protects the payload, so the server only
decides *who* gets an update, never *what* they get.
:::

:::quiz id=rs-08-q4 xp=10
You copied the platform entries into `latest.json` by hand and set `"signature": "ClipDesk_1.4.0_x64-setup.exe.sig"`
for Windows. The macOS and Linux entries are correct. What do Windows users on 1.3.2 see?
- [ ] The update installs: the plugin downloads the `.sig` file from that name
- [x] The update is refused: the signature field must contain the `.sig` file's content, so verification fails
- [ ] Only macOS and Linux are affected, because Windows uses Authenticode instead
- [ ] The app downgrades to the previous version
> `signature` holds the **content** of the `.sig` file. A file name doesn't verify against the public
> key, so the plugin refuses to install. Nothing is installed, and the user stays on 1.3.2. That's the
> safe failure, but it's still a failure. Generate `latest.json` with tooling (tauri-action) and
> check it in CI. That's exactly what the lab does.
:::

:::quiz id=rs-08-q5 xp=10
The laptop holding the updater **private key** was wiped, and there's no backup. What's the impact?
- [ ] None: run `tauri signer generate` again and keep publishing
- [ ] Only macOS users are affected, because their builds are notarized
- [x] Installed copies only trust the old public key, so no future update can reach them. Users must reinstall by hand
- [ ] GitHub can restore the key from the release's `.sig` files
> The public key is compiled into every install. A new keypair signs updates that old installs reject.
> You can ship a new key with a new installer, but every existing user has to download it themselves.
> Keep this key backed up and out of the repo, and store it in CI as a secret.
:::

## Semver in code: the comparison the updater makes

The heart of the update check is "is the remote version greater than mine?". Comparing version
strings as plain text is a classic bug: `"1.10.0" < "1.9.0"` is `true` as strings. SemVer 2.0 has
precise rules:

```text
1. Compare MAJOR, MINOR, PATCH as numbers.             1.10.0  >  1.9.0
2. A pre-release is LOWER than the same release.       1.4.0-rc.1  <  1.4.0
3. Pre-release identifiers, dot by dot:
   - both numeric      → compare as numbers             beta.2  <  beta.11
   - both alphanumeric → compare as ASCII text          alpha   <  beta
   - numeric vs text   → numeric is lower               1.0.0-1 <  1.0.0-alpha
   - all equal so far  → the shorter one is lower       alpha   <  alpha.1
4. Build metadata (+…) is IGNORED for precedence.       1.4.0+ci.77  ==  1.4.0+ci.76
```

In Rust the `semver` crate does this (`Version::parse`, and `cmp_precedence` to ignore build
metadata). In the browser we'll write it ourselves.

:::quiz id=rs-08-q6 xp=10
Will this compile? If not, which error?

```rust
use semver::Version;

fn main() {
    if Version::parse("1.4.0") > Version::parse("1.3.2") {
        println!("update available");
    }
}
```
- [ ] It compiles and prints `update available`
- [x] `error[E0369]`: binary operation `>` cannot be applied to type `Result<Version, semver::Error>`
- [ ] `error[E0277]`: the `?` operator can only be used in a function that returns `Result`
- [ ] `error[E0382]`: use of moved value
> `Version::parse` returns a `Result`, and you can only compare `Result`s if their error type can be
> compared too. `semver::Error` can't. Unwrap first (`Version::parse("1.4.0")?` in a function returning
> `Result`, or `.unwrap()` in a test). Rust makes you decide what happens for an invalid version string.
> In TypeScript, the same code would happily compare two objects and return `false`.
:::

:::challenge id=rs-08-c1 lang=ts xp=45
title: compareSemver: precedence like the updater
Write `compareSemver(a, b)` that returns `-1` if `a < b`, `0` if they have equal precedence, and
`1` if `a > b`, following SemVer 2.0:

- An optional leading `v` is allowed (`v1.4.0`).
- `MAJOR.MINOR.PATCH` compare numerically.
- A version with a pre-release (`-rc.1`) is lower than the same version without one.
- Pre-release identifiers compare dot by dot: numbers numerically, text as ASCII, numbers below
  text, and a shorter list is lower when all earlier identifiers are equal.
- Build metadata (`+…`) is ignored.
- Anything else (`1.4`, `01.2.3`, `latest`) throws an `Error`.

hint: Parse with one regex: `^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`
hint: Compare the three numbers first. Then: no pre-release beats a pre-release.
hint: For identifiers, `/^\d+$/.test(id)` tells you whether it's numeric.

```ts starter
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  // TODO: this compares text, so "1.10.0" < "1.9.0". Implement SemVer precedence.
  if (a === b) return 0
  return a < b ? -1 : 1
}
```

```ts solution
type ParsedVersion = { core: number[]; pre: string[] }

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseVersion(v: string): ParsedVersion {
  const m = SEMVER.exec(v.trim())
  if (!m) throw new Error(`invalid version: ${v}`)
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

function sign(n: number): -1 | 0 | 1 {
  return n < 0 ? -1 : n > 0 ? 1 : 0
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return sign(x.core[i] - y.core[i])
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    // a release beats any pre-release of the same version
    return sign(y.pre.length - x.pre.length)
  }
  const n = Math.min(x.pre.length, y.pre.length)
  for (let i = 0; i < n; i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === q) continue
    const pNum = /^\d+$/.test(p)
    const qNum = /^\d+$/.test(q)
    if (pNum && qNum) return sign(Number(p) - Number(q))
    if (pNum !== qNum) return pNum ? -1 : 1
    return p < q ? -1 : 1
  }
  return sign(x.pre.length - y.pre.length)
}
```

```ts tests
test('equal versions are 0', () => {
  expect(compareSemver('1.4.0', '1.4.0')).toBe(0)
})
test('numbers compare numerically, not as text', () => {
  expect(compareSemver('1.10.0', '1.9.0')).toBe(1)
  expect(compareSemver('1.9.0', '1.10.0')).toBe(-1)
  expect(compareSemver('2.0.0', '1.99.99')).toBe(1)
  expect(compareSemver('1.4.10', '1.4.9')).toBe(1)
})
test('a leading v is allowed', () => {
  expect(compareSemver('v1.4.0', '1.4.0')).toBe(0)
  expect(compareSemver('v1.4.1', 'v1.4.0')).toBe(1)
})
test('a pre-release is lower than its release', () => {
  expect(compareSemver('1.4.0-rc.1', '1.4.0')).toBe(-1)
  expect(compareSemver('1.4.0', '1.4.0-rc.1')).toBe(1)
  expect(compareSemver('1.5.0-beta.1', '1.4.0')).toBe(1)
})
test('the SemVer spec ordering of pre-releases', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let i = 0; i < ordered.length - 1; i++) {
    expect(compareSemver(ordered[i], ordered[i + 1])).toBe(-1)
    expect(compareSemver(ordered[i + 1], ordered[i])).toBe(1)
  }
})
test('numeric identifiers are lower than text ones', () => {
  expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
})
test('build metadata is ignored', () => {
  expect(compareSemver('1.4.0+ci.77', '1.4.0+ci.76')).toBe(0)
  expect(compareSemver('1.4.0-rc.1+abc', '1.4.0-rc.1')).toBe(0)
})
test('invalid versions throw', () => {
  expect(() => compareSemver('1.4', '1.4.0')).toThrow()
  expect(() => compareSemver('01.2.3', '1.2.3')).toThrow()
  expect(() => compareSemver('latest', '1.0.0')).toThrow()
})
```
:::

## Model the updater check

Now put the rules together the way the plugin applies them. ClipDesk adds one policy of its own on
top: **stable users never jump to a pre-release** unless they opted in, but users already on a beta
may move up to the next beta or the release.

:::challenge id=rs-08-c2 lang=ts xp=55
title: decideUpdate: parse latest.json and decide
`compareSemver` from the previous challenge is provided (setup). Write
`decideUpdate(json, platform, current, opts?)`, which returns one of:

- `{ action: 'error', reason }` when the JSON is invalid, `version` isn't a string, `platforms` is
  missing, **any** platform entry lacks a non-empty `url` or `signature` (Tauri validates the whole
  file), or `version` isn't valid SemVer.
- `{ action: 'none', reason: 'up-to-date' }` when the remote version isn't greater than `current`
  (checked **before** the platform lookup).
- `{ action: 'none', reason: 'prerelease' }` when the remote version is a pre-release, `current` is
  not, and `opts.allowPrerelease` isn't `true`.
- `{ action: 'error', reason }` with a reason containing `platform` when the update is newer but
  `platforms[platform]` doesn't exist.
- Otherwise `{ action: 'update', version, url, signature, notes }`, where `notes` is `''` when missing.

It must **never throw**.

hint: Wrap `JSON.parse` and `compareSemver` in `try/catch` and turn failures into `error` decisions.
hint: `Object.entries(m.platforms)` lets you check every entry before you look at the one you need.
hint: A version is a pre-release when the part before any `+` contains a `-`: `v.split('+')[0].includes('-')`.

```ts setup
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    const m = SEMVER.exec(v.trim())
    if (!m) throw new Error(`invalid version: ${v}`)
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
  }
  const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0)
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return sign(x.core[i] - y.core[i])
  if (x.pre.length === 0 || y.pre.length === 0) return sign(y.pre.length - x.pre.length)
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return sign(Number(p) - Number(q))
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return sign(x.pre.length - y.pre.length)
}

type Decision =
  | { action: 'update'; version: string; url: string; signature: string; notes: string }
  | { action: 'none'; reason: 'up-to-date' | 'prerelease' }
  | { action: 'error'; reason: string }
```

```ts starter
export function decideUpdate(
  json: string,
  platform: string,
  current: string,
  opts: { allowPrerelease?: boolean } = {},
): Decision {
  // TODO: validate the whole file, compare versions with compareSemver,
  // apply the pre-release policy, then look up the platform. Never throw.
  const m = JSON.parse(json)
  const entry = m.platforms[platform]
  return { action: 'update', version: m.version, url: entry.url, signature: entry.signature, notes: m.notes ?? '' }
}
```

```ts solution
export function decideUpdate(
  json: string,
  platform: string,
  current: string,
  opts: { allowPrerelease?: boolean } = {},
): Decision {
  let m: any
  try {
    m = JSON.parse(json)
  } catch {
    return { action: 'error', reason: 'invalid json' }
  }
  if (!m || typeof m !== 'object' || typeof m.version !== 'string') {
    return { action: 'error', reason: 'missing version' }
  }
  if (!m.platforms || typeof m.platforms !== 'object') {
    return { action: 'error', reason: 'missing platforms' }
  }
  for (const [key, entry] of Object.entries<any>(m.platforms)) {
    const ok = entry && typeof entry.url === 'string' && entry.url !== '' &&
      typeof entry.signature === 'string' && entry.signature !== ''
    if (!ok) return { action: 'error', reason: `incomplete entry for ${key}` }
  }

  let cmp: number
  try {
    cmp = compareSemver(m.version, current)
  } catch {
    return { action: 'error', reason: 'invalid version' }
  }
  if (cmp <= 0) return { action: 'none', reason: 'up-to-date' }

  const isPre = (v: string) => v.split('+')[0].includes('-')
  if (isPre(m.version) && !isPre(current) && opts.allowPrerelease !== true) {
    return { action: 'none', reason: 'prerelease' }
  }

  if (!Object.prototype.hasOwnProperty.call(m.platforms, platform)) {
    return { action: 'error', reason: `platform ${platform} not found` }
  }
  const entry = m.platforms[platform]
  return {
    action: 'update',
    version: m.version,
    url: entry.url,
    signature: entry.signature,
    notes: typeof m.notes === 'string' ? m.notes : '',
  }
}
```

```ts tests
const SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ=='
const entry = (file: string) => ({ url: `https://github.com/you/clipdesk/releases/download/v1.4.0/${file}`, signature: SIG })
const manifest = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  version,
  notes: 'Faster trimming',
  pub_date: '2026-11-02T10:00:00Z',
  platforms: {
    'darwin-aarch64': entry('ClipDesk_aarch64.app.tar.gz'),
    'darwin-x86_64': entry('ClipDesk_x64.app.tar.gz'),
    'linux-x86_64': entry('ClipDesk_1.4.0_amd64.AppImage'),
    'windows-x86_64': entry('ClipDesk_1.4.0_x64-setup.exe'),
    ...extra,
  },
})

test('offers a newer version for the matching platform', () => {
  expect(decideUpdate(manifest('1.4.0'), 'windows-x86_64', '1.3.2')).toEqual({
    action: 'update',
    version: '1.4.0',
    url: 'https://github.com/you/clipdesk/releases/download/v1.4.0/ClipDesk_1.4.0_x64-setup.exe',
    signature: SIG,
    notes: 'Faster trimming',
  })
})
test('compares numerically: 1.10.0 is newer than 1.9.3', () => {
  expect(decideUpdate(manifest('1.10.0'), 'linux-x86_64', '1.9.3').action).toBe('update')
})
test('same or older remote version means up-to-date (no downgrade)', () => {
  expect(decideUpdate(manifest('1.4.0'), 'darwin-aarch64', '1.4.0')).toEqual({ action: 'none', reason: 'up-to-date' })
  expect(decideUpdate(manifest('1.3.0'), 'darwin-aarch64', '1.4.0')).toEqual({ action: 'none', reason: 'up-to-date' })
  expect(decideUpdate(manifest('v1.4.0+ci.9'), 'darwin-aarch64', '1.4.0+ci.8')).toEqual({ action: 'none', reason: 'up-to-date' })
})
test('one incomplete entry breaks the check for every platform', () => {
  const broken = manifest('1.4.0', { 'linux-aarch64': { url: 'https://example.com/x.AppImage', signature: '' } })
  expect(decideUpdate(broken, 'windows-x86_64', '1.3.2').action).toBe('error')
  const noUrl = manifest('1.4.0', { 'windows-i686': { signature: SIG } })
  expect(decideUpdate(noUrl, 'darwin-x86_64', '1.3.2').action).toBe('error')
})
test('invalid JSON or version becomes an error decision, never a throw', () => {
  expect(decideUpdate('{ "version": ', 'linux-x86_64', '1.0.0').action).toBe('error')
  expect(decideUpdate(JSON.stringify({ version: 'latest', platforms: {} }), 'linux-x86_64', '1.0.0').action).toBe('error')
  expect(decideUpdate(JSON.stringify({ version: '1.4.0' }), 'linux-x86_64', '1.0.0').action).toBe('error')
  expect(decideUpdate('null', 'linux-x86_64', '1.0.0').action).toBe('error')
})
test('a newer version without our platform is an error mentioning the platform', () => {
  const d = decideUpdate(manifest('1.4.0'), 'linux-aarch64', '1.3.2')
  expect(d.action).toBe('error')
  expect((d as { reason: string }).reason).toMatch(/platform/)
})
test('the version is checked before the platform lookup', () => {
  expect(decideUpdate(manifest('1.4.0'), 'linux-aarch64', '1.4.0')).toEqual({ action: 'none', reason: 'up-to-date' })
})
test('stable users skip pre-releases unless they opt in', () => {
  expect(decideUpdate(manifest('1.5.0-beta.1'), 'linux-x86_64', '1.4.0')).toEqual({ action: 'none', reason: 'prerelease' })
  expect(decideUpdate(manifest('1.5.0-beta.1'), 'linux-x86_64', '1.4.0', { allowPrerelease: true }).action).toBe('update')
})
test('beta users move up to the next beta and to the release', () => {
  expect(decideUpdate(manifest('1.5.0-beta.2'), 'linux-x86_64', '1.5.0-beta.1').action).toBe('update')
  expect(decideUpdate(manifest('1.5.0'), 'linux-x86_64', '1.5.0-beta.2').action).toBe('update')
})
test('notes default to an empty string', () => {
  const json = JSON.stringify({ version: '2.0.0', platforms: { 'linux-x86_64': entry('a.AppImage') } })
  expect(decideUpdate(json, 'linux-x86_64', '1.0.0')).toMatchObject({ action: 'update', notes: '' })
})
```
:::

## CI: one tag, every platform

Building locally only gives you your own OS, and it puts signing keys on your laptop. A **GitHub
Actions matrix** runs the same job on Windows, macOS and Linux runners in parallel. The official
**tauri-apps/tauri-action** builds the app, uploads the bundles to a GitHub release and writes
`latest.json`.

```text
 git tag v1.4.0 && git push --tags
            │
            ▼
 ┌──────────────── publish (matrix, fail-fast: false) ────────────────┐
 │ macos-latest  aarch64 ─┐                                           │
 │ macos-latest  x86_64  ─┤  checkout → node → rust → cache → deps    │
 │ ubuntu-22.04          ─┤  → tauri-action (build, sign, upload)     │
 │ windows-latest        ─┘                                           │
 └──────────────────────────────┬─────────────────────────────────────┘
                                ▼
           DRAFT release v1.4.0: bundles + .sig + latest.json
                                │   verify job: release gate
                                ▼
           a human clicks Publish ──▶ /releases/latest/ now points here
                                ──▶ installed apps see the update
```

Key decisions in that pipeline:

- **`fail-fast: false`**: a flaky macOS notarization shouldn't cancel the Windows build that's
  almost done.
- **Draft releases** (`releaseDraft: true`): `releases/latest/download/latest.json` ignores drafts,
  so **nothing reaches users until a person publishes the draft**. That's your last checkpoint.
- **Caching**: `swatinem/rust-cache` with `workspaces: './src-tauri -> target'` saves most of the
  Rust compile time on later runs (cold Tauri builds take many minutes per OS).
- **macOS architectures**: either two matrix entries (`--target aarch64-apple-darwin` and
  `--target x86_64-apple-darwin`, which gives two smaller downloads), or one
  `--target universal-apple-darwin` (one fat binary). Either way the runner needs both Rust targets
  installed.
- **Secrets**: `TAURI_SIGNING_PRIVATE_KEY` and `_PASSWORD` for the updater, and the `APPLE_*` values
  for signing and notarization. These go into repository **Settings → Secrets and variables →
  Actions**, never into the repo. The default `GITHUB_TOKEN` needs `contents: write` to create
  releases.

:::quiz id=rs-08-q7 xp=10
The endpoint is `https://github.com/you/clipdesk/releases/latest/download/latest.json`. CI just
finished v1.4.0 as a **draft** release with all bundles and `latest.json`. When do installed copies of
1.3.2 see the update?
- [ ] Immediately, because the draft contains `latest.json`
- [x] Only after someone publishes the draft, because `/releases/latest/` ignores drafts (and pre-releases)
- [ ] Never, because the updater can't read GitHub releases
- [ ] After 24 hours, when GitHub's CDN cache expires
> GitHub's `latest` redirect points at the newest **published, non-prerelease** release. A draft is
> invisible to it. That gives you a natural review gate: install the draft's bundles on a test
> machine, then publish. Marking a release as *pre-release* keeps it out of `latest` too, which is
> one simple way to run a beta channel with a second endpoint.
:::

:::pro title="Harden the pipeline"
- Pin third-party actions to a full commit SHA (`uses: tauri-apps/tauri-action@<sha> # v1.x.y`), so
  a hijacked tag can't run code that has your signing secrets.
- Put the signing secrets in a GitHub **environment** (`environment: release`) with required
  reviewers, so a random branch can't sign builds.
- Run `cargo audit` (RustSec advisory database) and `npm audit` before the build job.
- Use separate keys per product, and write down how to rotate them *before* you need to.
:::

:::quiz id=rs-08-q8 xp=10
The lab's `release-gate` CLI starts like this. Will it compile? If not, which error?

```rust
fn main() {
    let text = std::fs::read_to_string("latest.json")?;
    println!("{text}");
}
```
- [ ] It compiles: `?` panics with a message if the file is missing
- [x] `error[E0277]`: the `?` operator can only be used in a function that returns `Result` or `Option`
- [ ] `error[E0308]`: mismatched types, expected `String`, found `&str`
- [ ] `error[E0599]`: no method named `read_to_string` found
> `?` returns early with the error, so the enclosing function must return a `Result` (or `Option`).
> `main` returns `()`. Fix it with `fn main() -> Result<(), Box<dyn std::error::Error>>`, or, as the
> lab does, return `std::process::ExitCode` and `match` on the result, so CI gets a clear message and
> a non-zero exit code. rs-03 covers `?` and error types in depth.
:::

:::lab id=rs-08-lab1 xp=150
title: Boss: ship ClipDesk
Make ClipDesk shippable. When you're done: one `git push --tags` builds Windows, macOS (both CPUs) and
Linux, signs every updater artifact, publishes `latest.json` to a draft release, and a Rust **release
gate** blocks a broken manifest before you can publish it.

You need the ClipDesk app from **Tauri 2: a desktop app with a web frontend** (rs-05), or any Tauri 2
app made with `npm create tauri-app@latest` (TypeScript, npm). You also need a GitHub repository you
can push to, **Rust stable 1.90 or newer** (the updater plugin needs it, and edition 2024 needs 1.85),
and Node 22+.

:::info
Apple and Windows signing certificates cost money and take days to get. The lab works without them:
the updater signature (step 1) is free and **required**. The OS signing steps are marked optional.
Without them, the builds still succeed, and users just see the OS warnings explained above.
:::

**1. Updater keys and plugin**

```bash
cd clipdesk
npm run tauri signer generate -- -w ~/.tauri/clipdesk.key
npm run tauri add updater
npm run tauri add process
```

Enter a password when asked, and save the key and password in your password manager. `tauri add`
installs `tauri-plugin-updater` and `@tauri-apps/plugin-updater` (and the same for `process`) and
registers the plugins. Check that `src-tauri/src/lib.rs` now contains something like:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**2. Configure bundling and the updater** in `src-tauri/tauri.conf.json`. Merge these keys into
what's already there, and replace `you` with your GitHub user and the `pubkey` with the content of
`~/.tauri/clipdesk.key.pub` (`cat ~/.tauri/clipdesk.key.pub`):

```json
{
  "productName": "ClipDesk",
  "version": "1.0.0",
  "bundle": {
    "active": true,
    "targets": "all",
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "PASTE THE CONTENT OF clipdesk.key.pub HERE",
      "endpoints": ["https://github.com/you/clipdesk/releases/latest/download/latest.json"],
      "windows": { "installMode": "passive" }
    }
  }
}
```

Add the permissions to `src-tauri/capabilities/default.json` (keep your existing ones):

```json
{
  "permissions": ["core:default", "updater:default", "process:allow-restart"]
}
```

**3. Check for updates on startup.** Create `src/updater.ts`:

```ts
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export async function updateOnStartup(): Promise<void> {
  try {
    const update = await check()
    if (!update) return
    const ok = confirm(`ClipDesk ${update.version} is available.\n\n${update.body ?? ''}\n\nInstall and restart?`)
    if (!ok) return
    await update.downloadAndInstall()
    await relaunch()
  } catch (e) {
    // Never let a failed update check break the app (offline, bad manifest, ...)
    console.warn('update check failed', e)
  }
}
```

Call `updateOnStartup()` once in `src/main.tsx` (or `main.ts`), **before** anything that might crash
on bad local data.

**4. A local signed build**

```bash
# macOS / Linux
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/clipdesk.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='your password'
npm run tauri build
ls src-tauri/target/release/bundle/*/
```

```powershell
# Windows PowerShell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\clipdesk.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'your password'
npm run tauri build
dir src-tauri\target\release\bundle\*\
```

Expected on Linux: `appimage/ClipDesk_1.0.0_amd64.AppImage` **and** `ClipDesk_1.0.0_amd64.AppImage.sig`,
plus `deb/` and `rpm/` packages. On macOS: `macos/ClipDesk.app.tar.gz` + `.sig` and `dmg/`. On
Windows: `nsis/…-setup.exe` + `.sig` and `msi/….msi` + `.sig`. If the `.sig` files are missing, the
build ends with an error about the missing private key, or `createUpdaterArtifacts` isn't set.

**5. The release gate (Rust).** In the repo root (next to `src-tauri`):

```bash
cargo new release-gate
cd release-gate
cargo add serde --features derive
cargo add serde_json semver
mkdir tests
```

`release-gate/Cargo.toml` should now say `edition = "2024"` and list `semver`, `serde` and
`serde_json`. Replace `release-gate/src/main.rs` and create `release-gate/src/lib.rs`:

```rust
// release-gate/src/lib.rs
//! release-gate: refuses to publish a latest.json that would break the updater.
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt;

use semver::Version;
use serde::Deserialize;

/// The static updater manifest Tauri's updater plugin downloads.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub platforms: BTreeMap<String, Platform>,
}

#[derive(Debug, Deserialize)]
pub struct Platform {
    pub url: String,
    pub signature: String,
}

#[derive(Debug, PartialEq)]
pub enum GateError {
    BadJson(String),
    BadVersion(String),
    NotNewer { new: String, previous: String },
    MissingPlatform(String),
    Unsigned(String),
    NotHttps(String),
}

impl fmt::Display for GateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GateError::BadJson(e) => write!(f, "latest.json is not valid: {e}"),
            GateError::BadVersion(v) => write!(f, "not a semver version: {v}"),
            GateError::NotNewer { new, previous } => {
                write!(f, "{new} is not newer than {previous}; clients would ignore it")
            }
            GateError::MissingPlatform(p) => write!(f, "platform {p} is missing"),
            GateError::Unsigned(p) => write!(f, "platform {p} has an empty or path-like signature"),
            GateError::NotHttps(p) => write!(f, "platform {p} url is not https"),
        }
    }
}

impl std::error::Error for GateError {}

/// The desktop platform keys ClipDesk ships for.
pub const REQUIRED: [&str; 4] = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

/// Parses "1.4.0" or "v1.4.0".
pub fn parse_version(s: &str) -> Result<Version, GateError> {
    let trimmed = s.strip_prefix('v').unwrap_or(s);
    Version::parse(trimmed).map_err(|e| GateError::BadVersion(format!("{s} ({e})")))
}

/// Checks a latest.json against the previously published version.
/// Returns the new version when the manifest is safe to publish.
pub fn check(json: &str, previous: &str, required: &[&str]) -> Result<Version, GateError> {
    let manifest: Manifest =
        serde_json::from_str(json).map_err(|e| GateError::BadJson(e.to_string()))?;
    let new = parse_version(&manifest.version)?;
    let prev = parse_version(previous)?;

    // SemVer precedence: pre-release < release, build metadata ignored.
    if new.cmp_precedence(&prev) != Ordering::Greater {
        return Err(GateError::NotNewer { new: new.to_string(), previous: prev.to_string() });
    }

    for key in required {
        let Some(p) = manifest.platforms.get(*key) else {
            return Err(GateError::MissingPlatform(key.to_string()));
        };
        if !p.url.starts_with("https://") {
            return Err(GateError::NotHttps(key.to_string()));
        }
        // The signature is the CONTENT of the .sig file, never a path or URL.
        let sig = p.signature.trim();
        if sig.is_empty() || sig.ends_with(".sig") || sig.starts_with("http") {
            return Err(GateError::Unsigned(key.to_string()));
        }
    }
    Ok(new)
}
```

```rust
// release-gate/src/main.rs
use std::process::ExitCode;

use release_gate::{check, REQUIRED};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: release-gate <latest.json> <previous-version>");
        return ExitCode::from(2);
    }
    let json = match std::fs::read_to_string(&args[1]) {
        Ok(text) => text,
        Err(e) => {
            eprintln!("release gate failed: cannot read {}: {e}", args[1]);
            return ExitCode::FAILURE;
        }
    };
    match check(&json, &args[2], &REQUIRED) {
        Ok(v) => {
            println!("release gate ok: {v} > {} ({} platforms signed)", args[2], REQUIRED.len());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("release gate failed: {e}");
            ExitCode::FAILURE
        }
    }
}
```

Paste the tests into `release-gate/tests/gate.rs`:

```rust
use release_gate::{check, parse_version, GateError, REQUIRED};

const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK";

fn manifest(version: &str, platforms: &[(&str, &str, &str)]) -> String {
    let entries: Vec<String> = platforms
        .iter()
        .map(|(k, url, sig)| format!(r#""{k}": {{ "url": "{url}", "signature": "{sig}" }}"#))
        .collect();
    format!(
        r#"{{ "version": "{version}", "notes": "Faster trimming", "pub_date": "2026-11-02T10:00:00Z", "platforms": {{ {} }} }}"#,
        entries.join(", ")
    )
}

fn all_platforms() -> Vec<(&'static str, &'static str, &'static str)> {
    REQUIRED
        .iter()
        .map(|k| (*k, "https://example.com/releases/download/v1.4.0/ClipDesk.bin", SIG))
        .collect()
}

#[test]
fn accepts_a_complete_newer_manifest() {
    let json = manifest("1.4.0", &all_platforms());
    assert_eq!(check(&json, "1.3.2", &REQUIRED).unwrap().to_string(), "1.4.0");
}

#[test]
fn accepts_a_leading_v() {
    assert_eq!(parse_version("v2.0.0").unwrap().major, 2);
}

#[test]
fn rejects_same_or_older_version() {
    let json = manifest("1.3.2", &all_platforms());
    assert!(matches!(check(&json, "1.3.2", &REQUIRED), Err(GateError::NotNewer { .. })));
    let json = manifest("1.3.10", &all_platforms());
    assert!(check(&json, "1.3.9", &REQUIRED).is_ok(), "10 > 9 numerically, not as text");
}

#[test]
fn release_beats_its_own_prerelease() {
    let json = manifest("1.4.0", &all_platforms());
    assert!(check(&json, "1.4.0-beta.3", &REQUIRED).is_ok());
    let json = manifest("1.4.0-beta.3", &all_platforms());
    assert!(matches!(check(&json, "1.4.0", &REQUIRED), Err(GateError::NotNewer { .. })));
}

#[test]
fn build_metadata_does_not_count_as_newer() {
    let json = manifest("1.4.0+ci.77", &all_platforms());
    assert!(matches!(check(&json, "1.4.0+ci.76", &REQUIRED), Err(GateError::NotNewer { .. })));
}

#[test]
fn rejects_a_missing_platform() {
    let mut platforms = all_platforms();
    platforms.retain(|(k, _, _)| *k != "darwin-aarch64");
    let json = manifest("1.4.0", &platforms);
    assert_eq!(
        check(&json, "1.3.2", &REQUIRED),
        Err(GateError::MissingPlatform("darwin-aarch64".into()))
    );
}

#[test]
fn rejects_a_signature_that_is_a_file_name() {
    let mut platforms = all_platforms();
    platforms[3] = ("windows-x86_64", "https://example.com/ClipDesk_1.4.0_x64-setup.exe", "ClipDesk_1.4.0_x64-setup.exe.sig");
    let json = manifest("1.4.0", &platforms);
    assert_eq!(check(&json, "1.3.2", &REQUIRED), Err(GateError::Unsigned("windows-x86_64".into())));
}

#[test]
fn rejects_plain_http() {
    let mut platforms = all_platforms();
    platforms[2] = ("linux-x86_64", "http://example.com/ClipDesk.AppImage", SIG);
    let json = manifest("1.4.0", &platforms);
    assert_eq!(check(&json, "1.3.2", &REQUIRED), Err(GateError::NotHttps("linux-x86_64".into())));
}

#[test]
fn rejects_broken_json() {
    assert!(matches!(check("{ \"version\": ", "1.0.0", &REQUIRED), Err(GateError::BadJson(_))));
}
```

Run them from `release-gate/`:

```bash
cargo test
```

Expected (order may vary):

```text
running 9 tests
test accepts_a_leading_v ... ok
test accepts_a_complete_newer_manifest ... ok
test build_metadata_does_not_count_as_newer ... ok
test rejects_a_missing_platform ... ok
test rejects_a_signature_that_is_a_file_name ... ok
test rejects_broken_json ... ok
test rejects_plain_http ... ok
test rejects_same_or_older_version ... ok
test release_beats_its_own_prerelease ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Try the binary against the sample manifest from the updater section above, saved as
`release-gate/sample.json`:

```bash
cargo run -q -- sample.json 1.3.2   # release gate ok: 1.4.0 > 1.3.2 (4 platforms signed)
cargo run -q -- sample.json 1.4.0   # release gate failed: 1.4.0 is not newer than 1.4.0; clients would ignore it
echo $?                             # 1
```

Add `release-gate/target/` to `.gitignore`.

**6. The release workflow.** Create `.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ['v*']

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  check-version:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: tag must match tauri.conf.json version
        run: |
          APP_VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
          if [ "v$APP_VERSION" != "$GITHUB_REF_NAME" ]; then
            echo "::error::tag $GITHUB_REF_NAME does not match version $APP_VERSION"
            exit 1
          fi

  publish:
    needs: check-version
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin
          - platform: macos-latest
            args: --target x86_64-apple-darwin
          - platform: ubuntu-22.04
            args: ''
          - platform: windows-latest
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v7

      - name: install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils

      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: npm

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - uses: swatinem/rust-cache@v2
        with:
          workspaces: './src-tauri -> target'

      - run: npm ci

      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          # Optional: macOS signing + notarization (delete these lines if you have no Apple Developer account)
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        with:
          tagName: v__VERSION__
          releaseName: 'ClipDesk v__VERSION__'
          releaseBody: 'See the assets below to download and install this version.'
          releaseDraft: true
          prerelease: false
          uploadUpdaterJson: true
          args: ${{ matrix.args }}

  verify:
    needs: publish
    runs-on: ubuntu-latest
    permissions:
      contents: write   # drafts are only visible to tokens with write access
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable
      - name: download latest.json from the draft
        run: gh release download "$GITHUB_REF_NAME" --pattern latest.json --dir gate
      - name: find the last published version
        run: echo "PREV=$(gh release view --json tagName --jq .tagName 2>/dev/null || echo v0.0.0)" >> "$GITHUB_ENV"
      - name: release gate
        run: cargo run -q --manifest-path release-gate/Cargo.toml -- gate/latest.json "$PREV"
```

The action tags (`@v7`, `@v6`, `@v1`) match Tauri's own example workflow. Before you sign real
releases with it, pin each one to a full commit SHA, as the "Harden the pipeline" callout says.
The `verify` job finds the draft through `gh`, which can only see drafts with a token that has
write access, hence `contents: write`. `gh release view` without a tag shows the latest
*published* release. When there is none yet, the step falls back to `v0.0.0`.

Add the secrets in **Settings → Secrets and variables → Actions**: `TAURI_SIGNING_PRIVATE_KEY`
(the *content* of `~/.tauri/clipdesk.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Add the
`APPLE_*` secrets only if you have them. Under **Settings → Actions → General → Workflow
permissions**, allow read and write if your organisation defaults to read-only.

:::tip
If you use a single universal macOS build instead, replace the two macOS matrix entries with one
whose `args` is `--target universal-apple-darwin`. Keep both Rust targets installed. The
`REQUIRED` list in the gate stays the same, because both `darwin-*` keys must still be in
`latest.json`.
:::

**7. Ship 1.0.0, then update to 1.0.1**

```bash
git add -A && git commit -m "release pipeline"
git tag v1.0.0 && git push && git push --tags
```

Wait for all four `publish` jobs and `verify` to go green. Open the draft release: you should see
the bundles, a `.sig` for every updater artifact, and `latest.json`. Publish the draft, then download
and install ClipDesk 1.0.0 on your machine.

Now bump `"version"` to `1.0.1` in `tauri.conf.json`, commit, and push `v1.0.1`. When the draft is
green, publish it, then start the installed 1.0.0: it should offer 1.0.1, install it and relaunch.

**8. Break it on purpose**

- Push a tag `v9.9.9` without changing `tauri.conf.json`: `check-version` fails, and nothing is built.
- Edit `release-gate/sample.json` to drop the `darwin-aarch64` entry and run
  `cargo run -q -- sample.json 1.3.2`: you get `release gate failed: platform darwin-aarch64 is missing`
  and exit code 1.
- Temporarily remove the `TAURI_SIGNING_PRIVATE_KEY` secret and re-run a job: the build fails
  because `createUpdaterArtifacts` needs a key. Put it back.

- [ ] `npm run tauri build` locally produces bundles **and** `.sig` files for your OS
- [ ] `cargo test` in `release-gate/` reports 9 passed
- [ ] `release-gate` exits 0 on a good manifest and 1 on a manifest with a missing platform
- [ ] Pushing a `v*` tag runs `check-version`, four `publish` jobs and `verify`, and creates a **draft** release with `latest.json`
- [ ] A tag that doesn't match `tauri.conf.json` fails the workflow before anything is built
- [ ] Installed 1.0.0 offered, installed and relaunched into 1.0.1 after you published the 1.0.1 draft
- [ ] Your private key and its password are backed up somewhere other than this machine
:::

## How it breaks in practice

- **"The update never shows up."** The release is still a draft or marked as a pre-release, so
  `/releases/latest/` points at the old one. Or `version` in `latest.json` isn't greater (maybe you
  re-released 1.4.0 with a fix). Bump the version and publish.
- **"Update check failed" on every OS after one platform job failed.** A half-written `latest.json`
  with an incomplete entry fails validation for *everyone*. Re-run the failed job, or remove the
  broken entry, and gate the manifest in CI like the lab does. Several matrix jobs update the same
  `latest.json` asset, so a flaky upload can leave it incomplete. Check the file before you publish.
- **Signature verification fails.** The app was built with a different `pubkey` than the key in CI,
  for example after someone "regenerated the key to fix CI". Or the `signature` field holds a file
  name. Old installs can't be fixed. Only a manual reinstall helps.
- **macOS: "ClipDesk is damaged and can't be opened."** This usually means the app was signed but
  not notarized, or modified after signing (for example by unzipping it with a tool that dropped
  extended attributes). Check with `codesign --verify --deep --strict` and `xcrun stapler validate`.
- **Notarization hangs or fails in CI.** An expired app-specific password, an Apple agreement that
  needs re-accepting in the developer portal, or a missing Team ID. The notarytool log names the
  missing entitlement or the unsigned binary.
- **Windows: SmartScreen still warns after you signed.** The reputation is new. It improves as
  more people download the app, and EV certificates don't skip that any more. Check that every
  signature has a **timestamp**, or it goes invalid when the certificate expires.
- **MSI build fails after a version bump.** `2026.1.0` or `1.4.0-beta.2` doesn't fit the MSI version
  format. Use a numeric `bundle.windows.wix.version`, or ship betas as NSIS only.
- **Linux build fails with missing `webkit2gtk-4.1`.** The runner lacks the system packages. Tauri 2
  needs `libwebkit2gtk-4.1-dev` (Tauri 1 used 4.0). Install them in an `if:` step for Ubuntu only.
- **Users stuck on a crashing version.** The update check ran after the code that crashes. Move it
  earlier, ship 1.4.1 with the fix, and tell stuck users to reinstall.

:::cards id=rs-08-cards1 xp=15 title="Shipping desktop apps"
Q: Which Windows installer formats does Tauri make, and where can each be built?
A: MSI (WiX, Windows only) and NSIS `-setup.exe` (Windows, or cross-compiled as a last resort).
Q: What do code signing and notarization prove?
A: Signing proves who published the file and that it wasn't changed. Notarization means Apple
   scanned it. Neither proves the app is "safe".
Q: What's the macOS chain for a downloadable app?
A: Developer ID Application cert → codesign with hardened runtime → notarytool submit → stapler staple.
Q: Why timestamp a Windows signature?
A: So the signature stays valid after the certificate expires.
Q: How does a new app earn SmartScreen reputation?
A: Over time, as more people download it. Since 2024 EV certificates no longer skip this.
Q: Updater signature vs Authenticode?
A: Separate. The updater only trusts your Tauri keypair (`tauri signer generate`), with the pubkey
   in `tauri.conf.json`. Authenticode/Developer ID is for the OS.
Q: Which env vars sign updater artifacts?
A: `TAURI_SIGNING_PRIVATE_KEY` (path or content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `.env` files aren't read.
Q: Required fields in latest.json?
A: `version` and, for each platform, `url` and `signature` (the .sig content). Optional: `notes`, `pub_date`.
Q: Give three platform keys.
A: `windows-x86_64`, `darwin-aarch64`, `linux-x86_64` (`OS-ARCH`).
Q: How do you roll back a bad release?
A: Ship forward: a higher version with the old code. The default comparator only upgrades.
Q: Why build releases as drafts?
A: `/releases/latest/` ignores drafts, so nobody gets the update until a person publishes it.
Q: What does `fail-fast: false` buy you in a release matrix?
A: One failing OS doesn't cancel the others, so you can re-run just the failed job.
:::

## Recap

- **Bundles are per OS**: MSI/NSIS on Windows, `.app`/`.dmg` on macOS (Intel, Apple silicon or
  universal), AppImage/`.deb`/`.rpm` on Linux, APK/AAB and IPA on mobile. Each OS builds its own,
  so releases use a **CI matrix**.
- **One version source** (`tauri.conf.json`) feeds installers, tags and updates. SemVer, and mind
  the MSI number limits.
- **OS signing** builds trust: Authenticode (hardware or cloud-HSM keys, timestamps, SmartScreen
  reputation earned over time), macOS Developer ID + hardened runtime + **notarization + stapling**.
  On Linux, signed repositories matter more than signed files.
- The **Tauri updater** installs only payloads signed with *your* keypair. Generate it with
  `tauri signer generate`, put the pubkey in config, keep the private key secret and backed up.
- **`latest.json`**: `version` plus `platforms["OS-ARCH"].url/signature` (signature = file content).
  The whole file is validated, and only greater versions are offered.
- **No automatic rollback**: ship forward, check for updates early, version your data, and keep
  pre-releases on their own channel.
- **CI**: `tauri-apps/tauri-action` in a `fail-fast: false` matrix, cached cargo, signing secrets
  in GitHub, **draft releases** as the human checkpoint, and a release gate that tests the manifest
  before anyone publishes it.
