---
id: dsk-10
title: MAUI Platform Features & Offline Data
level: advanced
minutes: 110
xp: 150
summary: Permissions, MAUI Essentials, app lifecycle, platform-specific code, local SQLite and an offline-first sync queue that survives 409 conflicts.
---

A desktop app on a desk usually has power, a network cable and one big window. A **phone app**
has none of that guaranteed: the user walks into a lift, the OS pauses your app to save battery,
the camera belongs to the system, and the location is private until the user says otherwise. This
lesson is about the parts of .NET MAUI that deal with that reality:

- **Permissions**: asking the user for access to the camera, location, notifications and similar.
- **MAUI Essentials**: one cross-platform API for preferences, secure storage, network state,
  GPS and photos.
- **App lifecycle**: knowing when you are being paused, resumed or killed.
- **Platform-specific code**: what to do when Android and iOS really differ.
- **Local data and offline-first sync**: a SQLite database on the device, plus a queue of changes
  that are replayed against the server and survive **409 Conflict** responses, the same
  optimistic-concurrency rule you built into the Capstone API.

:::warn title="MAUI does not build on Linux"
.NET MAUI apps target Android, iOS, macOS (Mac Catalyst) and Windows. The SDK workload is
available on **Windows and macOS only**: on Linux, `dotnet workload install maui` does not give you
a working MAUI build. In this lesson's lab, the data and sync layer is a normal `net10.0` class
library that builds and tests on any OS (Linux included). The MAUI app on top of it is
**verified on Windows/macOS by the learner**. If you only have Linux, do Part A and read Part B.
:::

## Why mobile apps need these features

Picture QuestBoard, our running quest tracker, on a phone. A tester ticks "Ship v1.0" on the
train, the signal drops for ten minutes, they take a photo of a whiteboard for a quest, then swipe
the app away. Three things must still be true:

1. The tick is **not lost**: it is stored on the device right away and sent later.
2. The photo was taken only after the user **allowed** camera access.
3. When the app comes back, it **syncs** without overwriting a teammate's newer change.

Each section below covers one piece of that story. The code is C# and XAML from a MAUI 10 app;
the challenges let you practise the sync logic in TypeScript, because the rules are the same in
any language.

## Permissions: declared, then requested

A **permission** is the user's consent for your app to touch something private or costly: location,
camera, microphone, contacts, notifications. Mobile OSes use a two-step model, and you need both
steps:

1. **Declare** the permission in the app package, so the OS (and the app store) knows you might
   ask. On Android this is a `<uses-permission>` line in `Platforms/Android/AndroidManifest.xml`.
   On iOS and Mac Catalyst it is a **usage description** string in `Platforms/iOS/Info.plist`,
   the sentence shown in the system dialog.
2. **Request** it at runtime, at the moment the user does something that needs it. The OS shows its
   dialog; the user can allow, deny, or (on some OSes) allow only once.

```xml
<!-- Platforms/Android/AndroidManifest.xml (inside <manifest>) -->
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.CAMERA" />
```

```xml
<!-- Platforms/iOS/Info.plist (inside the top-level <dict>) -->
<key>NSLocationWhenInUseUsageDescription</key>
<string>QuestBoard tags a quest with where you completed it.</string>
<key>NSCameraUsageDescription</key>
<string>QuestBoard attaches photos to quests.</string>
```

At runtime, MAUI's `Permissions` class wraps every platform behind one API. Each permission is a
nested class such as `Permissions.LocationWhenInUse` or `Permissions.Camera`, and every check
returns a `PermissionStatus` (`Granted`, `Denied`, `Restricted`, `Limited`, `Unknown`, …):

```csharp
public static async Task<bool> EnsureLocationAsync(Page page)
{
    var status = await Permissions.CheckStatusAsync<Permissions.LocationWhenInUse>();
    if (status == PermissionStatus.Granted) return true;

    // Android only: true when the user denied once, so explain before asking again.
    if (Permissions.ShouldShowRationale<Permissions.LocationWhenInUse>())
        await page.DisplayAlertAsync("Location", "We use it to tag finished quests.", "OK");

    status = await Permissions.RequestAsync<Permissions.LocationWhenInUse>();
    return status == PermissionStatus.Granted;
}
```

`CheckStatusAsync` only reads the current state; `RequestAsync` may show the system dialog. Call
both on the main (UI) thread. In MAUI 10, `DisplayAlertAsync` replaces the older `DisplayAlert`.

:::tip title="Ask in context, and survive a no"
Ask when the user taps **Add photo**, not at first launch: people allow what they understand. And
treat **Denied** as a normal path. The quest must still be saveable without a photo or a
location. On iOS a denied permission can't be re-requested from code. The best you can do is point
the user to Settings with `AppInfo.Current.ShowSettingsUI()`.
:::

:::quiz id=dsk-10-q1 xp=10
Your Android app calls `Permissions.RequestAsync<Permissions.Camera>()`, but no dialog appears and
the status is `Denied` immediately. The user never saw a prompt. What is the most likely cause?
- [ ] The camera is busy in another app
- [x] `android.permission.CAMERA` is not declared in `AndroidManifest.xml`
- [ ] `RequestAsync` must be called from a background thread
- [ ] Android never shows camera prompts; you must use `CheckStatusAsync`
> The OS only prompts for permissions the package **declares**. A missing manifest entry (or a
> missing `Info.plist` usage string on iOS, where the app is terminated instead) makes the request
> fail without any UI. A busy camera fails later, when you open it. Permission APIs belong on the
> main thread, not a background one. `CheckStatusAsync` only reads the state and never prompts.
:::

## MAUI Essentials: one API for device features

**MAUI Essentials** is the part of MAUI that wraps device features behind cross-platform
interfaces. Each feature has an interface (`IPreferences`, `IConnectivity`, …) and a ready
instance (`Preferences.Default`, `Connectivity.Current`, …). Prefer injecting the **interface**
through **dependency injection** (DI: you register services once in `MauiProgram.cs`, and MAUI
passes them into the constructors of pages and view models that ask for them). Your view models
then stay testable, because a unit test can pass a fake instead of the real device feature.

```csharp
// MauiProgram.cs: register the Essentials you use as interfaces
builder.Services.AddSingleton(Preferences.Default);   // IPreferences
builder.Services.AddSingleton(SecureStorage.Default); // ISecureStorage
builder.Services.AddSingleton(Connectivity.Current);  // IConnectivity
builder.Services.AddSingleton(Geolocation.Default);   // IGeolocation
builder.Services.AddSingleton(MediaPicker.Default);   // IMediaPicker
```

### Preferences: small settings

`Preferences` stores **simple key/value settings** (strings, numbers, booleans, dates) in the
platform's settings store (`SharedPreferences` on Android, `NSUserDefaults` on Apple). It's meant
for things like "dark theme on" or "last selected tab", not for data or secrets.

```csharp
Preferences.Default.Set("theme", "dark");
string theme = Preferences.Default.Get("theme", "system"); // second argument = default value
Preferences.Default.Remove("theme");
```

### SecureStorage: secrets

`SecureStorage` stores **small secrets** such as a refresh token, encrypted by the OS: Keychain on
iOS/macOS, Android Keystore-backed encryption on Android, DataProtection on Windows. It's async,
string-only, and it can throw on some devices, so wrap it in a `try`.

```csharp
await SecureStorage.Default.SetAsync("refresh_token", token);
string? saved = await SecureStorage.Default.GetAsync("refresh_token"); // null if missing
SecureStorage.Default.Remove("refresh_token");                         // on sign-out
```

:::warn title="Android backups can restore unreadable secrets"
Android Auto Backup can copy your app's files to a new phone, but the encryption keys stay behind.
The restored secure values then fail to decrypt. Exclude the secure-storage file from backup (or
disable auto backup) as the MAUI docs describe, and always handle "token missing" by asking the
user to sign in again.
:::

### Connectivity: is there a network?

`Connectivity` tells you the current **network access** level and raises an event when it changes:

```csharp
if (Connectivity.Current.NetworkAccess == NetworkAccess.Internet)
    await SyncAsync();

Connectivity.Current.ConnectivityChanged += (_, e) =>
{
    bool online = e.NetworkAccess == NetworkAccess.Internet;
    bool onWifi = e.ConnectionProfiles.Contains(ConnectionProfile.WiFi);
};
```

Android needs `ACCESS_NETWORK_STATE` in the manifest (the MAUI template already declares it).

:::quiz id=dsk-10-q2 xp=10
`Connectivity.Current.NetworkAccess` returns `NetworkAccess.Internet`. What does that guarantee?
- [ ] Your API server is up and will answer the next request
- [ ] The device is on Wi-Fi, so large uploads are fine
- [x] Nothing about your server: the OS only believes some internet route exists, so requests can still time out or fail
- [ ] That every queued change has already been synced
> `NetworkAccess.Internet` is the OS's best guess about the network link. A captive hotel portal,
> a dead server, or a slow mobile connection still fails your request. So use Connectivity as a
> **hint** (when to try syncing), and keep handling timeouts and errors in the sync code itself.
> The connection type comes from `ConnectionProfiles`, not from `NetworkAccess`.
:::

### Geolocation: where am I?

`Geolocation` gives you GPS/network location. It needs a location permission (above).
`GetLastKnownLocationAsync` is instant but may be stale or `null`. `GetLocationAsync` asks the
hardware for a fresh fix, with an accuracy and a timeout:

```csharp
var request = new GeolocationRequest(GeolocationAccuracy.Medium, TimeSpan.FromSeconds(10));
Location? here = await Geolocation.Default.GetLocationAsync(request);
if (here is not null)
    quest.Place = $"{here.Latitude:F4}, {here.Longitude:F4}";
```

### MediaPicker: camera and photos

`MediaPicker` opens the system camera or photo picker and returns a `FileResult`. That result is
a handle to a file you can open as a stream. Copy it into your app's own folder, because the
original may be a temporary file:

```csharp
if (MediaPicker.Default.IsCaptureSupported)
{
    FileResult? photo = await MediaPicker.Default.CapturePhotoAsync();
    if (photo is not null)
    {
        string target = Path.Combine(FileSystem.AppDataDirectory, photo.FileName);
        await using Stream source = await photo.OpenReadAsync();
        await using FileStream file = File.Create(target);
        await source.CopyToAsync(file);
    }
}
```

`PickPhotoAsync()` picks one existing photo, and MAUI 10 adds `PickPhotosAsync()` for several at
once. Capturing needs the camera permission. Picking uses the system photo picker, which on recent
Android versions needs no storage permission.

:::warn title="Mobile APIs move fast"
Method names and per-platform permission rules change between MAUI releases and OS versions
(for example `DisplayAlert` → `DisplayAlertAsync` and the new `PickPhotosAsync` in MAUI 10, or new
Android permission rules each year). The concepts in this lesson are stable; before you ship, check
the exact signatures and manifest entries in the official docs at
https://learn.microsoft.com/dotnet/maui/platform-integration/ for the MAUI version you use.
:::

:::quiz id=dsk-10-q3 xp=10
Where should QuestBoard keep each of these? Pick the combination that is correct.
- [ ] Refresh token in `Preferences`, quest list in `SecureStorage`, theme in SQLite
- [x] Refresh token in `SecureStorage`, theme in `Preferences`, quest list in a SQLite file under `FileSystem.AppDataDirectory`
- [ ] Everything in `Preferences`, because it is the simplest API
- [ ] Refresh token in a JSON file next to the app's executable, so it survives updates
> Secrets go into the OS-encrypted `SecureStorage`. `Preferences` is plain storage and only fits
> small settings like a theme. Structured, queryable, growing data (quests, the outbox) belongs in
> a database file in `FileSystem.AppDataDirectory`, the private, writable, backed-up folder.
> The install folder is read-only on phones, and a plaintext token there is readable by anyone
> who copies the files.
:::

## The app lifecycle

The **lifecycle** is the sequence of states the OS moves your app through: created, visible and
focused, in the background, back again, destroyed. On a phone the OS moves you to the background
whenever the user switches apps. It may then **kill your process without warning** to free memory.
Code that only saves "on exit" loses data.

MAUI raises these as events on the `Window`, in this order:

| Event | When | Typical use |
|---|---|---|
| `Created` | The native window exists | One-time setup |
| `Activated` | The window has focus | Resume animations, refresh the clock |
| `Deactivated` | Lost focus (dialog, split screen) | Pause video |
| `Stopped` | No longer visible: the app is in the background | **Save drafts, flush state now** |
| `Resumed` | Visible again after `Stopped` | Refresh data, **trigger a sync** |
| `Destroying` | The window is being destroyed | Unsubscribe; not guaranteed on mobile |

You subscribe where the window is created, in `App.CreateWindow` (in MAUI 9+ this replaces setting
`MainPage`):

```csharp
protected override Window CreateWindow(IActivationState? activationState)
{
    var window = new Window(new AppShell());
    window.Stopped += (_, _) => _drafts.SaveAll();          // may be the last chance
    window.Resumed += async (_, _) => await _sync.SyncAsync(); // back from the background
    return window;
}
```

For a hook that only exists on one platform, `ConfigureLifecycleEvents` in `MauiProgram` gives you
the native callbacks:

```csharp
using Microsoft.Maui.LifecycleEvents;

builder.ConfigureLifecycleEvents(events =>
{
#if ANDROID
    events.AddAndroid(android => android.OnResume(activity => Debug.WriteLine("Android resumed")));
#elif IOS || MACCATALYST
    events.AddiOS(ios => ios.OnActivated(app => Debug.WriteLine("iOS activated")));
#endif
});
```

:::quiz id=dsk-10-q4 xp=10
A user types a long quest description, switches to another app, and Android kills QuestBoard an
hour later to reclaim memory. Which event was your **last reliable** chance to save the draft?
- [ ] `Destroying`
- [ ] `Deactivated`
- [x] `Stopped`
- [ ] `Resumed`
> When the OS kills a backgrounded process, it does not run more of your code: `Destroying` is
> never raised. `Stopped` fires when the app leaves the screen, which is the last moment you can
> count on. `Deactivated` also fires for small things like a permission dialog, so saving there
> works but runs far more often than needed. `Resumed` comes after the user returns, which is too
> late.
:::

## Platform-specific code

MAUI's promise is "one codebase", but sometimes Android and iOS really differ: a native API, a
look-and-feel tweak, or a feature only one OS has. A MAUI project **multi-targets**: it is compiled
once per platform (`net10.0-android`, `net10.0-ios`, `net10.0-maccatalyst`,
`net10.0-windows10.0.19041.0`). There are four tools, from smallest to biggest.

**1. Runtime checks.** Use them for small differences in behaviour. Every platform's code is
compiled; the check runs on the device.

```csharp
if (DeviceInfo.Current.Platform == DevicePlatform.iOS)
    padding = new Thickness(0, 20, 0, 0);
```

XAML has the same idea with `OnPlatform`: `Padding="{OnPlatform iOS='0,20,0,0', Default='0'}"`.

**2. Conditional compilation (`#if`).** Use it when you call a native API that doesn't even exist
on the other platforms. The compiler drops the other branches. The symbols are `ANDROID`, `IOS`,
`MACCATALYST` and `WINDOWS`.

```csharp
public static string OsName()
{
#if ANDROID
    return $"Android API {Android.OS.Build.VERSION.SdkInt}";
#elif IOS || MACCATALYST
    return UIKit.UIDevice.CurrentDevice.SystemName;
#else
    return DeviceInfo.Current.Platform.ToString();
#endif
}
```

**3. Partial classes per platform.** Use these when a whole implementation differs. Declare a
`partial` class with a `partial` method in shared code, and implement it in a file under
`Platforms/<Name>/`. MAUI's build only compiles files in `Platforms/Android/` for Android,
`Platforms/iOS/` for iOS, and so on. Every target must provide the method, or the build fails for
that target.

```csharp
// Services/StorageInfo.cs (shared)
namespace QuestBoard.Services;
public partial class StorageInfo
{
    public partial long FreeBytes();
}
```

```csharp
// Platforms/Android/StorageInfo.cs (compiled for Android only)
namespace QuestBoard.Services;
public partial class StorageInfo
{
    public partial long FreeBytes() =>
        new Android.OS.StatFs(FileSystem.AppDataDirectory).AvailableBytes;
}
```

**4. Handlers.** Use a handler to change how a MAUI control maps to its **native view**. A
**handler** is the object that creates the native control (an Android `EditText` for a MAUI
`Entry`) and copies each property onto it through a **mapper**, a dictionary from property name to
"apply this to the native view". You can append your own entry to a mapper. This classic example
removes the Android underline from every `Entry`:

```csharp
// MauiProgram.cs, before builder.Build()
Microsoft.Maui.Handlers.EntryHandler.Mapper.AppendToMapping("NoUnderline", (handler, view) =>
{
#if ANDROID
    handler.PlatformView.BackgroundTintList =
        Android.Content.Res.ColorStateList.ValueOf(Android.Graphics.Color.Transparent);
#elif IOS || MACCATALYST
    handler.PlatformView.BorderStyle = UIKit.UITextBorderStyle.None;
#endif
});
```

`handler.PlatformView` is the real native control, so anything the native SDK allows is possible.

:::quiz id=dsk-10-q5 xp=10
You add `Platforms/iOS/StorageInfo.cs` implementing `public partial long FreeBytes()`, plus the
shared declaration, then build `-f net10.0-android`. The build fails with "partial method must have
an implementation". Why?
- [ ] iOS files must use `#if IOS` around their contents
- [x] Files under `Platforms/iOS/` are not compiled for Android, so the Android target has a declaration with no implementation
- [ ] Partial methods can't return a value
- [ ] Partial classes can't be split across folders
> MAUI only compiles each `Platforms/<Name>/` folder for its own target. A partial method with an
> access modifier **must** have an implementation in every compilation, so Android needs its own
> `Platforms/Android/StorageInfo.cs` (and so do Windows and Mac Catalyst). Since C# 9, partial
> methods may return values when they have an accessibility modifier. Folders don't matter to
> partial classes; only the namespace and class name must match. `#if IOS` is unnecessary inside
> the iOS folder.
:::

:::pro title="Keep platform code at the edges"
Seniors push platform-specific code into small services behind interfaces (`IStorageInfo`,
`INetworkStatus`) and register the right implementation in `MauiProgram`. View models then depend
only on interfaces and can be unit-tested in a plain `net10.0` test project, without an emulator.
The lab below is built exactly this way.
:::

## Local data with SQLite

A phone app needs a **local database** for anything bigger than a few settings: it must work
offline, start instantly without waiting for the network, and hold changes that haven't been sent
yet. **SQLite** is the standard choice. It is a whole SQL database in a single file, embedded in
your process, with no server to run. Put the file in `FileSystem.AppDataDirectory`, which is
private to your app and writable on every platform.

There are two popular ways to use it from .NET:

| | **sqlite-net-pcl** | **EF Core SQLite** (`Microsoft.EntityFrameworkCore.Sqlite`) |
|---|---|---|
| Style | Tiny ORM: attributes + `Table<T>()` LINQ | Full EF Core: `DbContext`, change tracking, migrations |
| Schema changes | `CreateTableAsync<T>()` adds new columns; anything else is manual | Migrations, like on the server |
| Size / startup | Very small, fast | Bigger; slower cold start on iOS (no JIT) |
| Pick it when | Simple tables, small app, mobile-first | You share models/queries with the backend, or the schema is rich |

With **sqlite-net-pcl**, a class is a table, and attributes describe keys and indexes:

```csharp
using SQLite;

public class QuestItem
{
    [PrimaryKey] public string Id { get; set; } = "";
    [MaxLength(200)] public string Title { get; set; } = "";
    [Indexed] public bool Done { get; set; }
}

var db = new SQLiteAsyncConnection(Path.Combine(FileSystem.AppDataDirectory, "quests.db3"));
await db.CreateTableAsync<QuestItem>();                     // CREATE TABLE IF NOT EXISTS (+ new columns)
await db.InsertAsync(new QuestItem { Id = "q1", Title = "Slay the flaky test" });
List<QuestItem> open = await db.Table<QuestItem>().Where(q => !q.Done).ToListAsync();
```

With **EF Core**, it looks like the backend lessons. The only mobile-specific parts are the file
path and applying migrations at startup:

```csharp
builder.Services.AddDbContext<QuestDb>(options =>
    options.UseSqlite($"Data Source={Path.Combine(FileSystem.AppDataDirectory, "quests.db")}"));
// once at startup, from a scope:
// using var scope = app.Services.CreateScope();
// scope.ServiceProvider.GetRequiredService<QuestDb>().Database.Migrate();
```

:::quiz id=dsk-10-q6 xp=10
Why does a local quest change write the quest row **and** its outbox entry inside **one
transaction**?
- [ ] SQLite requires a transaction for every `UPDATE`
- [x] So a crash between the two writes can't leave a changed quest that will never be synced (or an outbox entry for a change that never happened)
- [ ] Transactions make the sync run in the background
- [ ] So the server receives both rows in one HTTP request
> A **transaction** makes several writes all-or-nothing. Without it, the app could be killed after
> updating the quest but before queuing the change. The UI would show the tick forever while the
> server never hears about it. This is the device-side version of the **transactional outbox**
> pattern from the backend lessons. SQLite does auto-commit single statements, but that doesn't
> help with two of them. The transaction is purely local and has nothing to do with HTTP.
:::

## Offline-first sync

**Offline-first** means the **local database is the source of truth for the UI**. Every user action
is written locally first and shown immediately; the network is only used to **sync** in the
background. This is the opposite of "call the API and show a spinner", and it is what makes an app
feel fast on a bad connection.

The core building block is an **outbox** (or **sync queue**): a table of changes that the server
has not confirmed yet. Each queued change (an **op**) contains:

- `id`: a unique **idempotency key**. If the request reached the server but the response was
  lost, the client retries. The server sees an id it has already applied and does not apply it
  twice.
- the target (`questId`) and the change itself (`done = true`).
- `baseVersion`: the server version the change was based on. This is optimistic concurrency, the
  same idea as `expectedVersion` in the Capstone API, where `PUT /api/projects/{id}/doc` answers
  **409 Conflict** with the server's `currentVersion` when someone saved in between.

**Replaying** the queue means sending ops oldest-first, one at a time, and deciding per answer:

| Server answer | Meaning | What the client does |
|---|---|---|
| `200` + new `version` | Accepted | Remove the op; remember the new version |
| `409` + `currentVersion` | Someone changed it since our base | Resolve the conflict (below) |
| No answer / timeout / `5xx` | Not our fault, try later | **Stop**, keep this op and all later ones, in order |
| Other `4xx` (400, 403, 404) | Retrying won't help | Drop the op and tell the user |

Two details trip people up:

- **Our own writes advance the version.** If the user ticks and unticks the same quest offline,
  both ops have `baseVersion: 1`. After the first succeeds the server is at version 2, so the second
  must be sent with base 2, or it conflicts with *ourselves*. Rebase later ops on the version you
  just received.
- **Order matters.** Stop at the first network failure instead of skipping ahead, otherwise a later
  "undo" could reach the server before the change it undoes.

### Resolving a 409

A **conflict** means two devices changed the same record from the same base. Common strategies,
from simplest to richest:

- **Server wins**: drop the local change, download the server's state. Simple, but loses user
  work.
- **Client wins / last writer wins**: retry with `baseVersion = currentVersion`, so the local change
  overwrites. Fine for single-field toggles such as "done".
- **Field-level merge**: if the two sides changed *different* fields, apply both. A real
  conflict only exists when they changed the same field.
- **Ask the user**: show both versions. Best for long text such as a story chapter in BranchStory.

```text
device A (offline)   base v1 → done=false ─────────────┐
device B (online)    base v1 → done=true  → server v2  │
                                                      ▼
A comes online: PUT expected=1 → 409 currentVersion=2
                PUT expected=2 → 200 version=3   (A's change wins, knowingly)
```

:::quiz id=dsk-10-q7 xp=10
The client sends a queued op, the server applies it, but the phone loses signal before the
`200` response arrives. The client retries the same op later. What prevents the change from being
applied twice?
- [ ] The `baseVersion`, because the retry will always get a 409
- [x] The op's unique id (idempotency key): the server remembers applied ids and returns the earlier result
- [ ] HTTP `PUT` is always idempotent, so nothing is needed
- [ ] Deleting the op before sending it
> An **idempotency key** lets the server recognise a retry and answer "already done" instead of
> applying it again. `baseVersion` alone would answer the retry with a 409. The client would then
> treat its own write as a teammate's conflict and might rebase and apply it again. `PUT` is
> idempotent only when the request carries the full state; "increment" or "append" style changes
> are not. Deleting the op before sending loses it whenever the request fails.
:::

:::quiz id=dsk-10-q8 xp=10
While replaying the outbox `[a, b, c]`, op `b` gets a network timeout. What should the sync do?
- [ ] Drop `b` and continue with `c`
- [ ] Skip `b`, send `c`, and put `b` at the end of the queue
- [x] Stop, keep `b` and `c` in the queue in their original order, and try again later
- [ ] Retry `b` in a tight loop until it succeeds
> A timeout says nothing about `b` being wrong, so dropping it loses data. Sending `c` first can
> reorder dependent changes (an undo before its do). A tight retry loop drains the battery and hits
> a struggling server. Stop, keep the order, and retry on the next trigger: connectivity
> regained, app resumed, or a backoff timer.
:::

:::challenge id=dsk-10-c1 lang=ts xp=60
title: Replay the offline queue
Write `replayQueue(queue, send)`, which sends the offline ops to the server **one at a time, in
order** (await each `send` before the next), and returns a report. `send(op)` resolves to the
server's answer: `{ status: 200, version }`, `{ status: 409, currentVersion }`, `{ status: 0 }`
(no network) or another status such as `404` or `503`.

Rules:

1. **Rebase on your own writes:** send each op with `baseVersion` = the version you got back for
   that `questId` earlier in this replay, or the op's own `baseVersion` if none.
2. **200:** push the op id to `synced`, store `versions[questId] = version`. `versions` only
   holds quests that got a 200 during this replay.
3. **409:** retry the op **once** with `baseVersion: currentVersion` (client wins). If the
   retry gets 200, the op goes into `synced` **and** `rebased`. Then handle the retry's answer like
   any other answer.
4. **0 or ≥ 500:** stop. `remaining` = this op and every later op, in order, each with its
   `baseVersion` rebased (rule 1).
5. **Any other status** (including a second 409): push the id to `failed` and continue.
6. Don't mutate the input array or its ops.

hint: Keep `const versions: Record<string, number> = {}`, and compute `versions[op.questId] ?? op.baseVersion` before every send.
hint: Use a classic `for (let i = 0; …)` loop so that on a network failure you can return `queue.slice(i)` (mapped to rebased copies).
hint: Build new objects with spread: `{ ...op, baseVersion: n }`. That also keeps the input unmutated.

```ts starter
export type Op = { id: string; questId: string; baseVersion: number; changes: Record<string, unknown> }
export type SendResult = { status: number; version?: number; currentVersion?: number }
export type ReplayReport = {
  synced: string[]
  rebased: string[]
  failed: string[]
  remaining: Op[]
  versions: Record<string, number>
}

export async function replayQueue(
  queue: Op[],
  send: (op: Op) => Promise<SendResult>,
): Promise<ReplayReport> {
  const report: ReplayReport = { synced: [], rebased: [], failed: [], remaining: [], versions: {} }
  for (const op of queue) {
    await send(op)
    report.synced.push(op.id) // TODO: look at the answer!
  }
  return report
}
```

```ts solution
export type Op = { id: string; questId: string; baseVersion: number; changes: Record<string, unknown> }
export type SendResult = { status: number; version?: number; currentVersion?: number }
export type ReplayReport = {
  synced: string[]
  rebased: string[]
  failed: string[]
  remaining: Op[]
  versions: Record<string, number>
}

export async function replayQueue(
  queue: Op[],
  send: (op: Op) => Promise<SendResult>,
): Promise<ReplayReport> {
  const report: ReplayReport = { synced: [], rebased: [], failed: [], remaining: [], versions: {} }
  const rebase = (op: Op): Op => ({ ...op, baseVersion: report.versions[op.questId] ?? op.baseVersion })

  for (let i = 0; i < queue.length; i++) {
    const op = rebase(queue[i])
    let res = await send(op)
    let retried = false
    if (res.status === 409) {
      retried = true
      res = await send({ ...op, baseVersion: res.currentVersion as number })
    }

    if (res.status === 200) {
      report.synced.push(op.id)
      if (retried) report.rebased.push(op.id)
      report.versions[op.questId] = res.version as number
    } else if (res.status === 0 || res.status >= 500) {
      report.remaining = queue.slice(i).map(rebase)
      return report
    } else {
      report.failed.push(op.id)
    }
  }
  return report
}
```

```ts tests
// A tiny fake server: quest versions + optional failures.
function fakeServer(versions: Record<string, number>, opts: { offlineAfter?: number; statusFor?: Record<string, number> } = {}) {
  const state = { ...versions }
  let calls = 0
  const send = fn(async (op: Op): Promise<SendResult> => {
    calls++
    if (opts.offlineAfter !== undefined && calls > opts.offlineAfter) return { status: 0 }
    const forced = opts.statusFor?.[op.id]
    if (forced) return { status: forced }
    if (state[op.questId] === undefined) return { status: 404 }
    if (state[op.questId] !== op.baseVersion) return { status: 409, currentVersion: state[op.questId] }
    state[op.questId] += 1
    return { status: 200, version: state[op.questId] }
  })
  return { send, state }
}
const op = (id: string, questId: string, baseVersion: number): Op => ({ id, questId, baseVersion, changes: { done: true } })

test('syncs ops in order and records the new versions', async () => {
  const { send } = fakeServer({ q1: 1, q2: 4 })
  const r = await replayQueue([op('a', 'q1', 1), op('b', 'q2', 4)], send)
  expect(r.synced).toEqual(['a', 'b'])
  expect(r.versions).toEqual({ q1: 2, q2: 5 })
  expect(r.remaining).toEqual([])
  expect(send.mock.calls.map((c: any[]) => c[0].id)).toEqual(['a', 'b'])
})

test('rebases a second edit of the same quest on our own write (no 409)', async () => {
  const { send } = fakeServer({ q1: 1 })
  const r = await replayQueue([op('a', 'q1', 1), op('b', 'q1', 1)], send)
  expect(send.mock.calls.map((c: any[]) => c[0].baseVersion)).toEqual([1, 2])
  expect(r.synced).toEqual(['a', 'b'])
  expect(r.rebased).toEqual([])
  expect(r.versions.q1).toBe(3)
})

test('a 409 from a teammate is retried once on currentVersion', async () => {
  const { send, state } = fakeServer({ q1: 5 })
  const r = await replayQueue([op('a', 'q1', 4)], send)
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1][0].baseVersion).toBe(5)
  expect(r.synced).toEqual(['a'])
  expect(r.rebased).toEqual(['a'])
  expect(state.q1).toBe(6)
  expect(r.versions).toEqual({ q1: 6 })
})

test('a second 409 gives up on that op and continues', async () => {
  const always409 = fn(async (o: Op): Promise<SendResult> =>
    o.questId === 'q1' ? { status: 409, currentVersion: 9 } : { status: 200, version: 2 })
  const r = await replayQueue([op('a', 'q1', 1), op('b', 'q2', 1)], always409)
  expect(always409).toHaveBeenCalledTimes(3)
  expect(r.failed).toEqual(['a'])
  expect(r.synced).toEqual(['b'])
  expect(r.rebased).toEqual([])
})

test('stops at a network failure and keeps the rest in order, rebased', async () => {
  const { send } = fakeServer({ q1: 1, q2: 1 }, { offlineAfter: 1 })
  const r = await replayQueue([op('a', 'q1', 1), op('b', 'q2', 1), op('c', 'q1', 1)], send)
  expect(send).toHaveBeenCalledTimes(2) // c was never sent
  expect(r.synced).toEqual(['a'])
  expect(r.remaining.map((o) => o.id)).toEqual(['b', 'c'])
  expect(r.remaining[1].baseVersion).toBe(2) // c rebased on a's write
})

test('5xx also stops; other 4xx fail the op and continue', async () => {
  const s1 = fakeServer({ q1: 1, q2: 1 }, { statusFor: { a: 404 } })
  const r1 = await replayQueue([op('a', 'q1', 1), op('b', 'q2', 1)], s1.send)
  expect(r1.failed).toEqual(['a'])
  expect(r1.synced).toEqual(['b'])

  const s2 = fakeServer({ q1: 1, q2: 1 }, { statusFor: { a: 503 } })
  const r2 = await replayQueue([op('a', 'q1', 1), op('b', 'q2', 1)], s2.send)
  expect(r2.synced).toEqual([])
  expect(r2.failed).toEqual([])
  expect(r2.remaining.map((o) => o.id)).toEqual(['a', 'b'])
})

test('sends one op at a time and never mutates the queue', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const slow = async (o: Op): Promise<SendResult> => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(5)
    inFlight--
    return { status: 200, version: o.baseVersion + 1 }
  }
  const queue = [op('a', 'q1', 1), op('b', 'q1', 1)]
  const copy = JSON.parse(JSON.stringify(queue))
  await replayQueue(queue, slow)
  expect(maxInFlight).toBe(1)
  expect(queue).toEqual(copy)
})
```
:::

### Keeping the outbox small

If the user ticks and unticks a quest ten times offline, sending ten requests is wasteful. Most
apps **coalesce** (combine) ops for the same record when they are queued:

- update after update: merge the changes into the existing op.
- update after create: fold the change into the create (the server has never seen the record).
- delete after create: remove both. The record never needs to reach the server.
- delete after update: drop the update and queue the delete.

:::challenge id=dsk-10-c2 lang=ts xp=40
title: Coalesce the outbox
Write `enqueue(queue, op)` that returns a **new** queue with `op` added, following these rules for
the pending op with the same `questId` (there is at most one):

- none: append `op`.
- pending `create` or `update`, new `update` (or `create`): merge into the pending op (same
  position, same `id` and `kind`): `changes = { ...pending.changes, ...op.changes }`.
- pending `create`, new `delete`: remove the create and do **not** add the delete.
- pending `update`, new `delete`: remove the update and append the delete.
- pending `delete`, anything new: `throw new Error('quest was deleted')`.

Never mutate the input array or its ops.

hint: `queue.findIndex(p => p.questId === op.questId)` finds the pending op.
hint: `queue.filter((_, i) => i !== idx)` removes it without mutating; `queue.map(...)` replaces it.

```ts starter
export type Kind = 'create' | 'update' | 'delete'
export type OutboxOp = { id: string; kind: Kind; questId: string; changes: Record<string, unknown> }

export function enqueue(queue: OutboxOp[], op: OutboxOp): OutboxOp[] {
  return [...queue, op]
}
```

```ts solution
export type Kind = 'create' | 'update' | 'delete'
export type OutboxOp = { id: string; kind: Kind; questId: string; changes: Record<string, unknown> }

export function enqueue(queue: OutboxOp[], op: OutboxOp): OutboxOp[] {
  const idx = queue.findIndex((p) => p.questId === op.questId)
  if (idx === -1) return [...queue, op]
  const pending = queue[idx]
  if (pending.kind === 'delete') throw new Error('quest was deleted')

  if (op.kind === 'update' || op.kind === 'create') {
    const merged = { ...pending, changes: { ...pending.changes, ...op.changes } }
    return queue.map((p, i) => (i === idx ? merged : p))
  }
  const without = queue.filter((_, i) => i !== idx)
  return pending.kind === 'create' ? without : [...without, op]
}
```

```ts tests
const mk = (id: string, kind: Kind, questId: string, changes: Record<string, unknown> = {}): OutboxOp =>
  ({ id, kind, questId, changes })

test('appends an op for a quest with nothing pending', () => {
  const q = enqueue([mk('1', 'update', 'q1', { done: true })], mk('2', 'update', 'q2', { done: true }))
  expect(q.map((o) => o.id)).toEqual(['1', '2'])
})

test('merges update into a pending update, keeping its id and position', () => {
  const start = [mk('1', 'update', 'q1', { done: true, title: 'A' }), mk('2', 'update', 'q2', { done: true })]
  const q = enqueue(start, mk('3', 'update', 'q1', { done: false }))
  expect(q).toHaveLength(2)
  expect(q[0]).toEqual(mk('1', 'update', 'q1', { done: false, title: 'A' }))
})

test('folds an update into a pending create', () => {
  const q = enqueue([mk('1', 'create', 'q9', { title: 'New' })], mk('2', 'update', 'q9', { done: true }))
  expect(q).toEqual([mk('1', 'create', 'q9', { title: 'New', done: true })])
})

test('create then delete cancels out', () => {
  const q = enqueue([mk('0', 'update', 'q1'), mk('1', 'create', 'q9', { title: 'New' })], mk('2', 'delete', 'q9'))
  expect(q.map((o) => o.id)).toEqual(['0'])
})

test('update then delete keeps only the delete, at the end', () => {
  const q = enqueue([mk('1', 'update', 'q1', { done: true }), mk('2', 'update', 'q2')], mk('3', 'delete', 'q1'))
  expect(q.map((o) => `${o.id}:${o.kind}`)).toEqual(['2:update', '3:delete'])
})

test('anything after a delete is an error', () => {
  expect(() => enqueue([mk('1', 'delete', 'q1')], mk('2', 'update', 'q1'))).toThrow('quest was deleted')
})

test('does not mutate the input', () => {
  const start = [mk('1', 'update', 'q1', { done: true })]
  const copy = JSON.parse(JSON.stringify(start))
  enqueue(start, mk('2', 'update', 'q1', { done: false }))
  enqueue(start, mk('3', 'delete', 'q1'))
  expect(start).toEqual(copy)
})
```
:::

:::job title="What you'll find in a real mobile codebase"
Expect a `SyncService` (or "sync engine") that runs on app start, on `Resumed`, on connectivity
regained and on a timer with **exponential backoff** (wait 1 s, 2 s, 4 s … after failures). You'll
also find a "pending changes" badge in the UI and a screen that lists failed changes. On the
server you'll see an `updated_since` endpoint for pulling changes, **tombstones** (deleted rows
kept as `deleted = true` so other devices learn about the delete), and idempotency keys stored
per user. When you pull from the server, skip records that still have pending local ops, or the
pull overwrites the user's unsynced work.
:::

## Push notifications (overview)

A **push notification** is a message your server sends to a device *through the platform's
push service*, even while your app isn't running. You never connect to the phone directly: every
platform has one gatekeeper.

| Platform | Push service |
|---|---|
| Android | **FCM**, Firebase Cloud Messaging |
| iOS / macOS | **APNs**, Apple Push Notification service |
| Windows | **WNS**, Windows Push Notification Services |

The flow is the same everywhere:

1. The app asks for permission. iOS always asks; Android 13+ needs `POST_NOTIFICATIONS` declared
   and requested.
2. The app registers with the push service and receives a **device token**, an address for this
   app on this device.
3. The app sends the token to **your** backend, which stores it per user. Tokens change, so send
   it again on every start.
4. When something happens, your backend calls FCM/APNs with the token and a payload; the OS shows
   the notification or wakes your app.

MAUI has no built-in push API. Teams use a library such as `Plugin.Firebase` or `Shiny.Push`, or
**Azure Notification Hubs**, which talks to all three services for you. A **local notification**
is different: the app schedules it on the device itself (a reminder), with no server involved.

:::tip title="Push says 'something changed', sync does the rest"
Keep payloads tiny and free of secrets ("quest q3 changed"), and treat delivery as **best effort**:
the OS may delay, merge or drop pushes. A common pattern is a *silent* (data-only) push that just
triggers your normal sync, so the data always arrives through the same tested, versioned path.
:::

:::quiz id=dsk-10-q9 xp=10
How does your ASP.NET Core server get a notification onto a user's iPhone?
- [ ] It opens a WebSocket to the phone's IP address
- [x] It sends the payload plus the device token the app registered to APNs (directly or via a service like Notification Hubs), and APNs delivers it
- [ ] It writes a row to the phone's SQLite database
- [ ] It calls `Connectivity.ConnectivityChanged` on the device
> Phones have no stable public address and sleep their radios, so only the OS's own push channel
> (APNs for Apple, FCM for Android, WNS for Windows) can reach them. The app's job is to get a
> device token and register it with your backend. The server can't reach into the device's
> database. `ConnectivityChanged` is a local event about the device's own network.
:::

:::lab id=dsk-10-lab1 xp=100
title: Offline quest list
You'll build QuestBoard's offline layer: a SQLite store with an outbox, a sync service that
resolves 409s, and view models, all in a plain `net10.0` library with tests (**Part A, any OS,
including Linux**). Then you'll put a MAUI UI on top that syncs when the network returns or the app
resumes (**Part B, verified on Windows/macOS by the learner**). The server is an in-memory
`FakeQuestApi` that behaves like the Capstone API: optimistic versions, 409 with
`currentVersion`, and idempotent op ids. A real typed HTTP client against the Capstone API follows in
**Boss: BranchStory Desktop & Mobile Client**.

**Part A: the offline library (Windows, macOS or Linux)**

```bash
mkdir QuestBoardOffline && cd QuestBoardOffline
dotnet new sln -n QuestBoardOffline
dotnet new classlib -n QuestBoard.Offline -f net10.0
dotnet new xunit -n QuestBoard.Offline.Tests -f net10.0
rm QuestBoard.Offline/Class1.cs QuestBoard.Offline.Tests/UnitTest1.cs
dotnet sln add QuestBoard.Offline QuestBoard.Offline.Tests
dotnet add QuestBoard.Offline.Tests reference QuestBoard.Offline
```

Replace `QuestBoard.Offline/QuestBoard.Offline.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.2" />
    <PackageReference Include="sqlite-net-pcl" Version="1.11.285" />
  </ItemGroup>

</Project>
```

`QuestBoard.Offline/Models.cs`: the two tables plus seed data:

```csharp
using SQLite;

namespace QuestBoard.Offline;

/// <summary>A quest as stored on the device.</summary>
public class QuestItem
{
    [PrimaryKey]
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public bool Done { get; set; }
    /// <summary>The last version the server confirmed for this quest.</summary>
    public int Version { get; set; }
}

/// <summary>One change waiting in the outbox until the server accepts it.</summary>
public class PendingOp
{
    [PrimaryKey, AutoIncrement]
    public int Seq { get; set; }
    /// <summary>Idempotency key: the server ignores an op it has already applied.</summary>
    public string OpId { get; set; } = "";
    public string QuestId { get; set; } = "";
    public bool Done { get; set; }
}

public static class QuestSeed
{
    public static IReadOnlyList<QuestItem> Initial { get; } =
    [
        new() { Id = "q1", Title = "Slay the flaky test", Version = 1 },
        new() { Id = "q2", Title = "Write the README", Version = 1 },
        new() { Id = "q3", Title = "Ship v1.0", Version = 1 },
    ];
}
```

`QuestBoard.Offline/QuestApi.cs`: the server contract and an in-memory fake that follows the
Capstone rules:

```csharp
namespace QuestBoard.Offline;

/// <summary>What the server said about one PUT.</summary>
public abstract record PutResult;
public sealed record Saved(int Version) : PutResult;            // 200
public sealed record Conflict(int CurrentVersion) : PutResult;  // 409
public sealed record Unreachable : PutResult;                   // no network, timeout, 5xx
public sealed record Rejected(int Status) : PutResult;          // 400, 403, 404 …

public interface IQuestApi
{
    Task<PutResult> PutDoneAsync(string questId, bool done, int expectedVersion, string opId);
}

/// <summary>An in-memory stand-in for the real API (tests + the lab app).</summary>
public sealed class FakeQuestApi : IQuestApi
{
    private readonly Dictionary<string, (bool Done, int Version)> _quests = new();
    private readonly Dictionary<string, int> _appliedOps = new();

    public FakeQuestApi()
    {
        foreach (var q in QuestSeed.Initial) _quests[q.Id] = (q.Done, q.Version);
    }

    public bool IsReachable { get; set; } = true;
    public int Calls { get; private set; }

    public (bool Done, int Version) Get(string id) => _quests[id];

    /// <summary>Simulates a teammate changing the quest from another device.</summary>
    public void EditOnServer(string id, bool done)
    {
        var current = _quests[id];
        _quests[id] = (done, current.Version + 1);
    }

    public Task<PutResult> PutDoneAsync(string questId, bool done, int expectedVersion, string opId)
    {
        Calls++;
        if (!IsReachable) return Task.FromResult<PutResult>(new Unreachable());
        if (_appliedOps.TryGetValue(opId, out var appliedVersion))
            return Task.FromResult<PutResult>(new Saved(appliedVersion)); // replayed op: no double apply
        if (!_quests.TryGetValue(questId, out var current))
            return Task.FromResult<PutResult>(new Rejected(404));
        if (current.Version != expectedVersion)
            return Task.FromResult<PutResult>(new Conflict(current.Version));

        var next = current.Version + 1;
        _quests[questId] = (done, next);
        _appliedOps[opId] = next;
        return Task.FromResult<PutResult>(new Saved(next));
    }
}
```

`QuestBoard.Offline/OfflineQuestStore.cs`: local writes go into the quest table **and** the
outbox in one transaction:

```csharp
using SQLite;

namespace QuestBoard.Offline;

/// <summary>The local SQLite database: the source of truth for the UI.</summary>
public sealed class OfflineQuestStore : IAsyncDisposable
{
    private readonly SQLiteAsyncConnection _db;

    public OfflineQuestStore(string dbPath)
    {
        _db = new SQLiteAsyncConnection(dbPath);
    }

    public async Task InitAsync()
    {
        await _db.CreateTableAsync<QuestItem>();
        await _db.CreateTableAsync<PendingOp>();
        if (await _db.Table<QuestItem>().CountAsync() == 0)
            await _db.InsertAllAsync(QuestSeed.Initial.Select(q => new QuestItem
            {
                Id = q.Id, Title = q.Title, Done = q.Done, Version = q.Version,
            }));
    }

    public Task<List<QuestItem>> GetQuestsAsync() =>
        _db.Table<QuestItem>().OrderBy(q => q.Title).ToListAsync();

    public Task<QuestItem> GetQuestAsync(string id) => _db.GetAsync<QuestItem>(id);

    public Task<int> PendingCountAsync() => _db.Table<PendingOp>().CountAsync();

    public Task<List<PendingOp>> PendingAsync() =>
        _db.Table<PendingOp>().OrderBy(o => o.Seq).ToListAsync();

    /// <summary>Change the quest locally AND queue the change, in one transaction.</summary>
    public Task SetDoneAsync(string questId, bool done) =>
        _db.RunInTransactionAsync(conn =>
        {
            var quest = conn.Get<QuestItem>(questId);
            quest.Done = done;
            conn.Update(quest);
            conn.Insert(new PendingOp { OpId = Guid.NewGuid().ToString("N"), QuestId = questId, Done = done });
        });

    /// <summary>The server accepted the op: remember its version, drop the op.</summary>
    public Task MarkSyncedAsync(PendingOp op, int serverVersion) =>
        _db.RunInTransactionAsync(conn =>
        {
            var quest = conn.Get<QuestItem>(op.QuestId);
            quest.Version = serverVersion;
            conn.Update(quest);
            conn.Delete(op);
        });

    public Task DropAsync(PendingOp op) => _db.DeleteAsync(op);

    public ValueTask DisposeAsync() => new(_db.CloseAsync());
}
```

`QuestBoard.Offline/SyncService.cs`: the C# version of challenge 1. It sends with the quest's
last confirmed `Version`, which already includes our own synced writes, so rebasing is automatic:

```csharp
namespace QuestBoard.Offline;

public sealed record SyncReport(int Synced, int Rebased, int Failed, int Remaining);

/// <summary>Replays the outbox against the server, oldest change first.</summary>
public sealed class SyncService(OfflineQuestStore store, IQuestApi api)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<SyncReport> SyncAsync()
    {
        await _gate.WaitAsync(); // never run two syncs at once
        try
        {
            int synced = 0, rebased = 0, failed = 0;
            foreach (var op in await store.PendingAsync())
            {
                // The quest's Version already includes our earlier synced ops,
                // so a second queued edit of the same quest is rebased automatically.
                var quest = await store.GetQuestAsync(op.QuestId);
                var result = await api.PutDoneAsync(op.QuestId, op.Done, quest.Version, op.OpId);
                bool retried = false;

                if (result is Conflict conflict)
                {
                    // Policy for a done-flag: the latest local tap wins. Retry ONCE on the server's version.
                    retried = true;
                    result = await api.PutDoneAsync(op.QuestId, op.Done, conflict.CurrentVersion, op.OpId);
                }

                switch (result)
                {
                    case Saved saved:
                        await store.MarkSyncedAsync(op, saved.Version);
                        synced++;
                        if (retried) rebased++; // count a conflict only when the retry was accepted
                        break;
                    case Unreachable:
                        // Stop: keep this op and everything after it, in order.
                        return new SyncReport(synced, rebased, failed, await store.PendingCountAsync());
                    default: // second conflict or a 4xx: retrying will not help
                        await store.DropAsync(op);
                        failed++;
                        break;
                }
            }
            return new SyncReport(synced, rebased, failed, await store.PendingCountAsync());
        }
        finally
        {
            _gate.Release();
        }
    }
}
```

`QuestBoard.Offline/QuestListViewModel.cs`: CommunityToolkit.Mvvm view models with no MAUI types,
so the tests can run them:

```csharp
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace QuestBoard.Offline;

/// <summary>Answers "can I reach the server right now?" (MAUI: Connectivity).</summary>
public interface INetworkStatus
{
    bool IsOnline { get; }
}

public partial class QuestRowViewModel(QuestItem quest, Func<QuestRowViewModel, Task> onToggle) : ObservableObject
{
    public string Id { get; } = quest.Id;
    public string Title { get; } = quest.Title;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ToggleText))]
    public partial bool Done { get; set; } = quest.Done;

    public string ToggleText => Done ? "Undo" : "Done";

    [RelayCommand]
    private Task ToggleAsync() => onToggle(this);
}

public partial class QuestListViewModel(OfflineQuestStore store, SyncService sync, INetworkStatus network, IQuestApi api)
    : ObservableObject
{
    private bool _ready;

    public ObservableCollection<QuestRowViewModel> Quests { get; } = [];

    [ObservableProperty]
    public partial string Status { get; set; } = "Loading…";

    [RelayCommand]
    private async Task LoadAsync()
    {
        await store.InitAsync();
        _ready = true;
        await RefreshAsync();
        await SyncAsync();
    }

    [RelayCommand]
    private async Task SyncAsync()
    {
        if (!_ready) return; // a network event can arrive before the page has loaded
        if (!network.IsOnline)
        {
            Status = await OfflineStatusAsync();
            return;
        }
        var report = await sync.SyncAsync();
        await RefreshAsync();
        Status = report switch
        {
            { Remaining: > 0 } => await OfflineStatusAsync(),
            { Failed: > 0 } => $"Synced {report.Synced}, {report.Failed} change(s) could not be saved",
            { Rebased: > 0 } => $"Synced {report.Synced} (resolved {report.Rebased} conflict(s))",
            _ => "All changes synced",
        };
    }

    /// <summary>Lab helper: pretend a teammate finished "Ship v1.0" on another device.</summary>
    [RelayCommand]
    private void SimulateTeammateEdit()
    {
        if (api is FakeQuestApi fake) fake.EditOnServer("q3", done: true);
    }

    private async Task ToggleQuestAsync(QuestRowViewModel row)
    {
        await store.SetDoneAsync(row.Id, !row.Done);
        row.Done = !row.Done;          // instant UI feedback, even offline
        await SyncAsync();
    }

    private async Task RefreshAsync()
    {
        Quests.Clear();
        foreach (var quest in await store.GetQuestsAsync())
            Quests.Add(new QuestRowViewModel(quest, ToggleQuestAsync));
    }

    private async Task<string> OfflineStatusAsync()
    {
        var pending = await store.PendingCountAsync();
        return pending == 0 ? "Offline — nothing to sync" : $"Offline — {pending} change(s) waiting";
    }
}
```

`QuestBoard.Offline.Tests/OfflineSyncTests.cs`:

```csharp
using QuestBoard.Offline;

namespace QuestBoard.Offline.Tests;

/// <summary>A fresh database file per test, deleted afterwards.</summary>
internal sealed class TestApp : IAsyncDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"questboard-{Guid.NewGuid():N}.db3");
    public OfflineQuestStore Store { get; }
    public FakeQuestApi Api { get; } = new();
    public SyncService Sync { get; }

    private TestApp()
    {
        Store = new OfflineQuestStore(_path);
        Sync = new SyncService(Store, Api);
    }

    public static async Task<TestApp> StartAsync()
    {
        var app = new TestApp();
        await app.Store.InitAsync();
        return app;
    }

    public async ValueTask DisposeAsync()
    {
        await Store.DisposeAsync();
        File.Delete(_path);
    }
}

internal sealed class FakeNetwork : INetworkStatus
{
    public bool IsOnline { get; set; } = true;
}

public class OfflineSyncTests
{
    [Fact]
    public async Task A_local_change_is_saved_and_queued()
    {
        await using var app = await TestApp.StartAsync();

        await app.Store.SetDoneAsync("q1", true);

        Assert.True((await app.Store.GetQuestAsync("q1")).Done);
        Assert.Equal(1, await app.Store.PendingCountAsync());
        Assert.False(app.Api.Get("q1").Done); // the server knows nothing yet
    }

    [Fact]
    public async Task Offline_changes_stay_queued_until_the_server_is_reachable()
    {
        await using var app = await TestApp.StartAsync();
        app.Api.IsReachable = false;
        await app.Store.SetDoneAsync("q1", true);
        await app.Store.SetDoneAsync("q2", true);

        var offline = await app.Sync.SyncAsync();
        Assert.Equal(new SyncReport(0, 0, 0, 2), offline);

        app.Api.IsReachable = true;
        var online = await app.Sync.SyncAsync();

        Assert.Equal(new SyncReport(2, 0, 0, 0), online);
        Assert.Equal((true, 2), app.Api.Get("q1"));
        Assert.Equal(2, (await app.Store.GetQuestAsync("q1")).Version);
    }

    [Fact]
    public async Task Two_queued_edits_of_one_quest_are_rebased_on_each_other()
    {
        await using var app = await TestApp.StartAsync();
        await app.Store.SetDoneAsync("q1", true);
        await app.Store.SetDoneAsync("q1", false);

        var report = await app.Sync.SyncAsync();

        Assert.Equal(new SyncReport(2, 0, 0, 0), report);
        Assert.Equal((false, 3), app.Api.Get("q1"));
    }

    [Fact]
    public async Task A_409_from_a_teammate_edit_is_resolved_by_retrying_on_the_server_version()
    {
        await using var app = await TestApp.StartAsync();
        app.Api.EditOnServer("q3", done: true);        // server: v2, done
        await app.Store.SetDoneAsync("q3", false);     // we still think v1

        var report = await app.Sync.SyncAsync();

        Assert.Equal(new SyncReport(1, 1, 0, 0), report);
        Assert.Equal((false, 3), app.Api.Get("q3"));
        Assert.Equal(3, (await app.Store.GetQuestAsync("q3")).Version);
    }

    [Fact]
    public async Task The_view_model_shows_offline_state_and_keeps_the_tap()
    {
        await using var app = await TestApp.StartAsync();
        var network = new FakeNetwork { IsOnline = false };
        var vm = new QuestListViewModel(app.Store, app.Sync, network, app.Api);

        await vm.LoadCommand.ExecuteAsync(null);
        var ship = vm.Quests.Single(q => q.Title == "Ship v1.0");
        await ship.ToggleCommand.ExecuteAsync(null);

        Assert.True(ship.Done);
        Assert.Equal("Undo", ship.ToggleText);
        Assert.Equal("Offline — 1 change(s) waiting", vm.Status);

        network.IsOnline = true;
        await vm.SyncCommand.ExecuteAsync(null);
        Assert.Equal("All changes synced", vm.Status);
        Assert.Equal((true, 2), app.Api.Get("q3"));
    }
}
```

Run the tests:

```bash
dotnet test
```

Expected output (the last line; duration varies):

```text
Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5, Duration: 64 ms - QuestBoard.Offline.Tests.dll (net10.0)
```

:::tip
Each test creates its own temporary `.db3` file and deletes it afterwards, so tests never share
state. If a test fails with "no such table", `InitAsync()` was not awaited before use.
:::

**Part B: the MAUI app (Windows or macOS only, verified by the learner)**

Install the workload once (Visual Studio 2026 on Windows can do this from its installer; on macOS
you also need Xcode for iOS/Mac Catalyst):

```bash
dotnet workload install maui
dotnet new maui -n QuestBoard.Mobile
dotnet sln add QuestBoard.Mobile
dotnet add QuestBoard.Mobile reference QuestBoard.Offline
```

`QuestBoard.Mobile/MauiNetworkStatus.cs`: the only platform-aware class, adapting MAUI
`IConnectivity` to the library's `INetworkStatus`:

```csharp
using QuestBoard.Offline;

namespace QuestBoard.Mobile;

public sealed class MauiNetworkStatus(IConnectivity connectivity) : INetworkStatus
{
    public bool IsOnline => connectivity.NetworkAccess == NetworkAccess.Internet;
}
```

Replace `QuestBoard.Mobile/MauiProgram.cs`:

```csharp
using Microsoft.Extensions.Logging;
using QuestBoard.Offline;

namespace QuestBoard.Mobile;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
            });

        var dbPath = Path.Combine(FileSystem.AppDataDirectory, "questboard.db3");
        builder.Services.AddSingleton(new OfflineQuestStore(dbPath));
        builder.Services.AddSingleton<IQuestApi, FakeQuestApi>();
        builder.Services.AddSingleton(Connectivity.Current);
        builder.Services.AddSingleton<INetworkStatus, MauiNetworkStatus>();
        builder.Services.AddSingleton<SyncService>();
        builder.Services.AddSingleton<QuestListViewModel>();
        builder.Services.AddTransient<MainPage>();

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

Replace `QuestBoard.Mobile/App.xaml.cs`. It syncs when the window comes back from the background
and when the network returns. `ConnectivityChanged` can fire on a background thread, so the sync
is marshalled to the UI thread, where `ObservableCollection` must be changed:

```csharp
using QuestBoard.Offline;

namespace QuestBoard.Mobile;

public partial class App : Application
{
    private readonly QuestListViewModel _quests;

    public App(QuestListViewModel quests, IConnectivity connectivity)
    {
        InitializeComponent();
        _quests = quests;
        connectivity.ConnectivityChanged += OnConnectivityChanged;
    }

    protected override Window CreateWindow(IActivationState? activationState)
    {
        var window = new Window(new AppShell());
        window.Resumed += async (_, _) => await _quests.SyncCommand.ExecuteAsync(null);
        return window;
    }

    private async void OnConnectivityChanged(object? sender, ConnectivityChangedEventArgs e)
    {
        await MainThread.InvokeOnMainThreadAsync(() => _quests.SyncCommand.ExecuteAsync(null));
    }
}
```

Replace `QuestBoard.Mobile/MainPage.xaml`. Compiled bindings use `x:DataType` on the page and
on the item template:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:offline="clr-namespace:QuestBoard.Offline;assembly=QuestBoard.Offline"
             x:Class="QuestBoard.Mobile.MainPage"
             x:DataType="offline:QuestListViewModel"
             Title="QuestBoard">
    <Grid RowDefinitions="Auto,*,Auto" Padding="16" RowSpacing="12">
        <Label Text="{Binding Status}" FontAttributes="Bold" FontSize="18" />
        <CollectionView Grid.Row="1" ItemsSource="{Binding Quests}">
            <CollectionView.ItemTemplate>
                <DataTemplate x:DataType="offline:QuestRowViewModel">
                    <Grid ColumnDefinitions="*,Auto" Padding="0,8">
                        <Label Text="{Binding Title}" VerticalOptions="Center" />
                        <Button Grid.Column="1" Text="{Binding ToggleText}" Command="{Binding ToggleCommand}" />
                    </Grid>
                </DataTemplate>
            </CollectionView.ItemTemplate>
        </CollectionView>
        <HorizontalStackLayout Grid.Row="2" Spacing="12">
            <Button Text="Sync now" Command="{Binding SyncCommand}" />
            <Button Text="Teammate edit" Command="{Binding SimulateTeammateEditCommand}" />
        </HorizontalStackLayout>
    </Grid>
</ContentPage>
```

Replace `QuestBoard.Mobile/MainPage.xaml.cs`. **Shell** (the `AppShell` the template creates: the
app's navigation container that hosts its pages) builds `MainPage` through DI, because the page is
registered in `MauiProgram`, so the constructor receives the view model:

```csharp
using QuestBoard.Offline;

namespace QuestBoard.Mobile;

public partial class MainPage : ContentPage
{
    private readonly QuestListViewModel _vm;

    public MainPage(QuestListViewModel vm)
    {
        InitializeComponent();
        BindingContext = _vm = vm;
    }

    protected override async void OnAppearing()
    {
        base.OnAppearing();
        await _vm.LoadCommand.ExecuteAsync(null);
    }
}
```

Run it. Android needs a running emulator or device; the template's `AndroidManifest.xml` already
declares `INTERNET` and `ACCESS_NETWORK_STATE`:

```bash
dotnet build QuestBoard.Mobile -t:Run -f net10.0-android        # Windows or macOS
dotnet build QuestBoard.Mobile -t:Run -f net10.0-maccatalyst    # macOS
```

On Windows you can also open `QuestBoardOffline.slnx` in Visual Studio 2026, pick **Windows
Machine**, and press F5.

Try the offline story:

1. Start online: the header says **All changes synced**.
2. Turn on airplane mode (Android emulator: swipe down, airplane icon; Mac: turn Wi-Fi off). Tap
   **Done** on "Slay the flaky test" and "Write the README". The buttons switch to **Undo** immediately and the header says
   **Offline — 2 change(s) waiting**.
3. Close the app completely, then open it again, still offline. The two quests still show **Undo**:
   they came from SQLite, not memory.
4. Tap **Teammate edit** (the fake server marks "Ship v1.0" done at a newer version), then tap
   **Done** on "Ship v1.0" yourself.
5. Turn the network back on. Within a moment the header shows
   **Synced 3 (resolved 1 conflict(s))**.

:::info
The `FakeQuestApi` lives in memory, so it forgets its versions when the app restarts while the
device keeps its own. The first sync after a restart then gets a 409 and heals itself through the
retry rule, which is a nice live demo of conflict handling.
:::

- [ ] Part A: `dotnet test` reports 5 passed, 0 failed
- [ ] I can explain why `SetDoneAsync` uses one transaction for the quest and the outbox entry
- [ ] Part B (Windows/macOS): the app shows **Offline — N change(s) waiting** in airplane mode, and the changes survive an app restart
- [ ] Part B: after **Teammate edit**, coming back online shows a resolved conflict instead of losing either change silently
- [ ] Stretch: save the last successful sync time with `Preferences.Default.Set("lastSync", DateTime.UtcNow)` and show it in the header
:::

:::cards id=dsk-10-cards1 xp=15 title="MAUI platform features & offline sync"
Q: What are the two steps for a mobile permission?
A: Declare it in the package (AndroidManifest.xml uses-permission / Info.plist usage string), then request it at runtime with Permissions.RequestAsync<T>() when the user needs the feature.
Q: Preferences vs SecureStorage?
A: Preferences: small plain settings (theme, last tab). SecureStorage: small secrets (refresh token), encrypted by Keychain / Android Keystore / DataProtection.
Q: Which window event is the last reliable moment to save on mobile?
A: Stopped. The app is in the background and may be killed without Destroying ever firing.
Q: Four ways to write platform-specific code in MAUI?
A: Runtime checks (DeviceInfo.Platform / OnPlatform), #if ANDROID/IOS/WINDOWS/MACCATALYST, partial classes in Platforms/<Name>/, and handler mappers (AppendToMapping) for native views.
Q: What does "offline-first" mean?
A: The local database is the UI's source of truth. Write locally first, show it immediately, and sync with the server in the background.
Q: What does an outbox op carry?
A: A unique id (idempotency key), the target record, the change, and the base version it was made against.
Q: The server answers 409 with currentVersion. What are your options?
A: Server wins (drop local), client wins (retry with baseVersion = currentVersion), field-level merge, or ask the user.
Q: Network failure in the middle of a replay?
A: Stop, keep the failed op and every later op in order, retry later (resume, connectivity regained, backoff timer).
Q: How does a push notification reach a phone?
A: Your server sends payload + device token to FCM / APNs / WNS, and the OS delivers it. Keep payloads small; often a silent push that triggers sync.
Q: sqlite-net-pcl or EF Core SQLite?
A: sqlite-net for small, simple, fast mobile storage; EF Core when you want migrations, rich models or code shared with the backend.
:::

## Recap

- Mobile permissions are **declared** in the manifest/Info.plist and **requested** at runtime with
  `Permissions.RequestAsync<T>()`. Ask in context and keep working when the answer is no.
- MAUI Essentials: `Preferences` for settings, `SecureStorage` for secrets, `Connectivity` as a
  hint for when to sync, `Geolocation` and `MediaPicker` for device features. Inject the interfaces
  so view models stay testable.
- Save on `Window.Stopped`, sync on `Resumed`. Mobile OSes kill background apps without calling
  `Destroying`.
- Platform differences, from small to big: runtime checks, `#if`, partial classes in
  `Platforms/<Name>/`, and handler mappers that reach the native view.
- Store data in SQLite under `FileSystem.AppDataDirectory` with sqlite-net-pcl or EF Core. Write
  the change and its outbox entry in **one transaction**.
- Offline-first sync replays the outbox in order, rebases on your own writes, resolves 409s with
  a clear policy, stops on network errors, and uses idempotency keys so retries are safe.
- Push goes through FCM/APNs/WNS using a device token. Treat it as a "something changed" nudge
  that triggers the normal sync.
