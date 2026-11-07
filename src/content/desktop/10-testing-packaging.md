---
id: dsk-11
title: Testing & Shipping Desktop and Mobile Apps
level: advanced
minutes: 100
xp: 150
summary: Unit-test ViewModels with xUnit, drive real Avalonia windows headlessly, then publish, sign and auto-update QuestBoard for Windows, macOS, Linux, Android and iOS from one CI matrix.
---

## Why this lesson exists

A web app ships when you push to `main`: the server updates and every user gets the new version on
their next page load. A desktop or mobile app is different. Each release is a **file that leaves
your control**. It gets copied onto thousands of machines, it has to start on operating systems you
never tested, and a bug stays installed until the user updates. You can't hot-fix a laptop in a
hotel room.

That changes two habits:

- **Testing has to happen before the file leaves.** You want fast tests for the logic (the
  ViewModels), plus a few UI tests that click through real windows. All of them should run in CI
  without a monitor attached.
- **Shipping is its own skill.** Picking the right build options, signing the file so the OS trusts
  it, packaging it the way each platform expects, and getting updates to users who already have it
  installed.

This lesson covers both. It uses **QuestBoard**, the quest tracker from the earlier lessons in this
region, and builds on the MVVM, binding, command and validation ideas from those lessons.

:::info title="Words you'll meet in this lesson"
- **Unit test**: a small automated check of one piece of code, run by a test framework (here
  **xUnit**).
- **Headless**: running a UI framework without a real screen. Windows exist in memory, input is
  simulated, and you can still take screenshots.
- **RID (Runtime Identifier)**: a short name for an OS + CPU pair, such as `win-x64`, `osx-arm64`
  or `linux-x64`. `dotnet publish -r <rid>` builds for that target.
- **Publish**: compiling and collecting everything an app needs into an output folder that can be
  copied to another machine.
- **Code signing**: attaching a cryptographic signature that proves who built a file and that it
  hasn't been changed since. Operating systems warn about, or block, unsigned apps.
- **Artifact**: any file a build produces and keeps, for example an installer, an `.aab` or a zip.
- **JIT (just-in-time compilation)**: .NET normally ships *intermediate language* (IL) and turns it
  into machine code while the app runs. **AOT (ahead-of-time)** does that work at build time instead.
- **Reflection**: code that looks up types, properties or methods *by name at runtime*
  (`typeof(T).GetProperty("Title")`). Tools that analyse your code before it runs can't see it.
:::

## Part 1: Testing

### The testing pyramid for MVVM apps

MVVM is a big advantage when you write tests. The ViewModel holds the logic: it decides whether
**Add** is enabled, trims the title and updates the status text. It knows nothing about pixels, so
you can test it like any plain C# class. That gives you a pyramid:

| Layer | What it checks | Speed | How many |
|---|---|---|---|
| **ViewModel unit tests** (xUnit) | Properties, commands, `CanExecute`, validation, change notifications | Milliseconds | Many (most of your tests) |
| **Headless UI tests** (Avalonia.Headless) | Bindings are wired, a click really runs the command, layout renders | ~100 ms each | Some (the key flows) |
| **End-to-end device tests** (Appium) | The packaged app on a real OS or phone | Seconds to minutes | Few (smoke tests) |

The higher the layer, the more realistic and the slower and flakier the test. A **flaky** test
sometimes passes and sometimes fails without any code change. Push every check as far down the
pyramid as it can go.

### Unit-testing a ViewModel with xUnit

**xUnit** is the most common .NET test framework. A test is a public method marked `[Fact]` (one
case) or `[Theory]` with `[InlineData(...)]` (the same test with several inputs). You check results
with `Assert.Equal(expected, actual)`, `Assert.True(...)` and friends. Each test gets a **new
instance** of the test class, so tests don't share state.

Here's the QuestBoard ViewModel (CommunityToolkit.Mvvm generates the `NewTitle` / `Status`
properties and the `AddQuestCommand` from the attributes):

```csharp
public partial class MainWindowViewModel : ObservableObject
{
    public ObservableCollection<string> Quests { get; } = new();

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]
    private string _newTitle = "";

    [ObservableProperty]
    private string _status = "No quests yet";

    private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewTitle);

    [RelayCommand(CanExecute = nameof(CanAddQuest))]
    private void AddQuest()
    {
        Quests.Add(NewTitle.Trim());
        NewTitle = "";
        Status = Quests.Count == 1 ? "1 quest" : $"{Quests.Count} quests";
    }
}
```

A good ViewModel test follows **Arrange, Act, Assert**: build the object, do one thing, check the
outcome.

```csharp
[Fact]
public void Add_is_disabled_while_title_is_blank()
{
    var vm = new MainWindowViewModel { NewTitle = "   " };   // Arrange

    var canAdd = vm.AddQuestCommand.CanExecute(null);       // Act

    Assert.False(canAdd);                                    // Assert
}
```

What's worth testing in a ViewModel:

1. **State after a command.** After `Execute`, are the collection, the input and the status right?
2. **`CanExecute` rules.** Especially at the edges: empty, whitespace only, exactly at the length
   limit.
3. **Change notification.** Does setting `NewTitle` raise `CanExecuteChanged`? If it doesn't, the
   button stays grey even though the rule says yes. This is the most common real-world MVVM bug,
   and only a test that **listens to the event** catches it.

```csharp
[Fact]
public void Typing_a_title_raises_CanExecuteChanged()
{
    var vm = new MainWindowViewModel();
    var raised = 0;
    vm.AddQuestCommand.CanExecuteChanged += (_, _) => raised++;

    vm.NewTitle = "Slay the bug";

    Assert.True(raised > 0);
}
```

:::tip title="Keep the ViewModel testable"
If a ViewModel calls `new HttpClient()`, `DateTime.Now`, a file dialog or a `MessageBox`, you
can't test it in isolation. Put those behind interfaces (`IQuestApi`, `TimeProvider`,
`IDialogService`), inject them through the constructor, and pass fakes in tests. .NET's built-in
`TimeProvider` and `FakeTimeProvider` (from `Microsoft.Extensions.TimeProvider.Testing`) make time
testable.
:::

:::quiz id=dsk-11-q1 xp=10
A teammate says: "We'll skip ViewModel tests and just write UI tests that click everything, because
they're more realistic." What's the strongest argument against that?
- [ ] UI tests can't check `CanExecute`
- [x] UI tests are slower and flakier, so the many edge cases (blank, whitespace, length limits) belong in fast ViewModel tests, with a few UI tests for the key flows
- [ ] xUnit can't run UI tests at all
- [ ] ViewModel tests are more realistic than UI tests
> UI tests *can* check that a button is disabled, but each one starts a window, lays it out and
> simulates input. That's roughly 100× slower and has more moving parts that can fail at random.
> The pyramid puts the many logic cases in fast unit tests and keeps a handful of UI tests to prove
> the wiring (bindings, commands) works. xUnit runs headless UI tests just fine (see below), and
> ViewModel tests are *less* realistic. That's the trade-off you make for speed.
:::

Before writing tests in C#, practise the thinking. The challenge below simulates a ViewModel in
TypeScript: a `title` property that raises change notifications, a computed `canSave` and a `save`
command. Your tests must catch every buggy version.

:::challenge id=dsk-11-c1 lang=ts mode=tests xp=60
title: Catch the ViewModel bugs
`QuestEditorViewModel` (shown below) simulates an MVVM ViewModel. `onPropertyChanged(fn)` registers
a listener that receives the name of every property that changed, like `INotifyPropertyChanged`.
Write tests that **pass** on this version and **fail** on each of five hidden buggy versions.

The rules:
- Setting `title` to a **new** value raises `"title"` and then `"canSave"`. Setting it to the
  **same** value raises nothing.
- `canSave` is true when the trimmed title is non-empty **and** the title is at most 40 characters.
- `save()` returns `false` and does nothing when `canSave` is false. Otherwise it pushes the trimmed
  title onto `saved`, clears `title` and returns `true`.

hint: Record notifications: `const names: string[] = []; vm.onPropertyChanged((p) => names.push(p))`
hint: Boundaries: try a title of exactly 40 characters (`'x'.repeat(40)`) and one of 41.
hint: Whitespace-only titles (`'   '`) and setting the same value twice both hide bugs.

```ts impl
type Listener = (prop: string) => void

export class QuestEditorViewModel {
  private _title = ''
  private listeners: Listener[] = []
  saved: string[] = []

  onPropertyChanged(fn: Listener) { this.listeners.push(fn) }
  private raise(prop: string) { for (const fn of this.listeners) fn(prop) }

  get title() { return this._title }
  set title(value: string) {
    if (value === this._title) return
    this._title = value
    this.raise('title')
    this.raise('canSave')
  }

  get canSave() { return this._title.trim().length > 0 && this._title.length <= 40 }

  save(): boolean {
    if (!this.canSave) return false
    this.saved.push(this._title.trim())
    this.title = ''
    return true
  }
}
```

```ts mutant
type Listener = (prop: string) => void

export class QuestEditorViewModel {
  private _title = ''
  private listeners: Listener[] = []
  saved: string[] = []

  onPropertyChanged(fn: Listener) { this.listeners.push(fn) }
  private raise(prop: string) { for (const fn of this.listeners) fn(prop) }

  get title() { return this._title }
  set title(value: string) {
    this._title = value
    this.raise('title')
    this.raise('canSave')
  }

  get canSave() { return this._title.trim().length > 0 && this._title.length <= 40 }

  save(): boolean {
    if (!this.canSave) return false
    this.saved.push(this._title.trim())
    this.title = ''
    return true
  }
}
```

```ts mutant
type Listener = (prop: string) => void

export class QuestEditorViewModel {
  private _title = ''
  private listeners: Listener[] = []
  saved: string[] = []

  onPropertyChanged(fn: Listener) { this.listeners.push(fn) }
  private raise(prop: string) { for (const fn of this.listeners) fn(prop) }

  get title() { return this._title }
  set title(value: string) {
    if (value === this._title) return
    this._title = value
    this.raise('title')
  }

  get canSave() { return this._title.trim().length > 0 && this._title.length <= 40 }

  save(): boolean {
    if (!this.canSave) return false
    this.saved.push(this._title.trim())
    this.title = ''
    return true
  }
}
```

```ts mutant
type Listener = (prop: string) => void

export class QuestEditorViewModel {
  private _title = ''
  private listeners: Listener[] = []
  saved: string[] = []

  onPropertyChanged(fn: Listener) { this.listeners.push(fn) }
  private raise(prop: string) { for (const fn of this.listeners) fn(prop) }

  get title() { return this._title }
  set title(value: string) {
    if (value === this._title) return
    this._title = value
    this.raise('title')
    this.raise('canSave')
  }

  get canSave() { return this._title.length > 0 && this._title.length <= 40 }

  save(): boolean {
    if (!this.canSave) return false
    this.saved.push(this._title.trim())
    this.title = ''
    return true
  }
}
```

```ts mutant
type Listener = (prop: string) => void

export class QuestEditorViewModel {
  private _title = ''
  private listeners: Listener[] = []
  saved: string[] = []

  onPropertyChanged(fn: Listener) { this.listeners.push(fn) }
  private raise(prop: string) { for (const fn of this.listeners) fn(prop) }

  get title() { return this._title }
  set title(value: string) {
    if (value === this._title) return
    this._title = value
    this.raise('title')
    this.raise('canSave')
  }

  get canSave() { return this._title.trim().length > 0 && this._title.length < 40 }

  save(): boolean {
    if (!this.canSave) return false
    this.saved.push(this._title.trim())
    this.title = ''
    return true
  }
}
```

```ts mutant
type Listener = (prop: string) => void

export class QuestEditorViewModel {
  private _title = ''
  private listeners: Listener[] = []
  saved: string[] = []

  onPropertyChanged(fn: Listener) { this.listeners.push(fn) }
  private raise(prop: string) { for (const fn of this.listeners) fn(prop) }

  get title() { return this._title }
  set title(value: string) {
    if (value === this._title) return
    this._title = value
    this.raise('title')
    this.raise('canSave')
  }

  get canSave() { return this._title.trim().length > 0 && this._title.length <= 40 }

  save(): boolean {
    this.saved.push(this._title.trim())
    this.title = ''
    return true
  }
}
```

```ts starter
test('title can be set', () => {
  const vm = new QuestEditorViewModel()
  vm.title = 'Slay the bug'
  expect(vm.title).toBe('Slay the bug')
})
```

```ts solution
test('a new value raises title then canSave', () => {
  const vm = new QuestEditorViewModel()
  const names: string[] = []
  vm.onPropertyChanged((p) => names.push(p))
  vm.title = 'Slay the bug'
  expect(names).toEqual(['title', 'canSave'])
})
test('the same value raises nothing', () => {
  const vm = new QuestEditorViewModel()
  vm.title = 'Slay the bug'
  const names: string[] = []
  vm.onPropertyChanged((p) => names.push(p))
  vm.title = 'Slay the bug'
  expect(names).toEqual([])
})
test('whitespace-only cannot be saved', () => {
  const vm = new QuestEditorViewModel()
  vm.title = '   '
  expect(vm.canSave).toBe(false)
})
test('exactly 40 characters can be saved, 41 cannot', () => {
  const vm = new QuestEditorViewModel()
  vm.title = 'x'.repeat(40)
  expect(vm.canSave).toBe(true)
  vm.title = 'x'.repeat(41)
  expect(vm.canSave).toBe(false)
})
test('save refuses when canSave is false', () => {
  const vm = new QuestEditorViewModel()
  expect(vm.save()).toBe(false)
  expect(vm.saved).toEqual([])
})
test('save stores the trimmed title and clears the input', () => {
  const vm = new QuestEditorViewModel()
  vm.title = '  Ship v1  '
  expect(vm.save()).toBe(true)
  expect(vm.saved).toEqual(['Ship v1'])
  expect(vm.title).toBe('')
})
```
:::

### Headless UI tests with Avalonia.Headless

ViewModel tests can't tell you whether the XAML is wired up correctly. For example, a typo in
`{Binding NewTitel}` (compiled bindings catch that at build time), the wrong command on the wrong
button, or a control that's hidden behind another one. For that you need the real view.

**Avalonia.Headless** is a platform backend that replaces the windowing system with an in-memory
one. Windows are created, laid out and rendered exactly as normal, but nothing appears on screen
and no display server is needed. That's why it runs on a CI machine with no monitor (including
Linux runners with no X11 or Wayland). The `Avalonia.Headless.XUnit` package connects it to xUnit.

How it fits together:

1. A test assembly attribute names an **app builder**, the same `AppBuilder.Configure<App>()` you
   use in `Program.cs`, but with `.UseHeadless(...)` instead of `.UsePlatformDetect()`.
2. You write tests with **`[AvaloniaFact]`** instead of `[Fact]`. It starts the headless app once
   per test session and runs each test on Avalonia's **UI thread**. Controls may only be touched
   from that thread. A plain `[Fact]` that creates a `Window` throws, because there's no running
   app and no UI thread.
3. In the test you create a window, call `Show()`, find controls by `x:Name` and simulate input
   with extension methods from `Avalonia.Headless`: `KeyTextInput("text")`,
   `KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None)`, `MouseDown(point, MouseButton.Left)`,
   `MouseUp(...)`.
4. Optionally `CaptureRenderedFrame()` returns a bitmap of the window. This needs real rendering
   (`.UseSkia()` plus `UseHeadlessDrawing = false`). Save it as a CI artifact to see what the
   window looked like when a test failed.

```csharp
[assembly: AvaloniaTestApplication(typeof(QuestBoard.Tests.TestAppBuilder))]

public class TestAppBuilder
{
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UseSkia()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false });
}
```

```csharp
[AvaloniaFact]
public void Add_button_starts_disabled()
{
    var window = new MainWindow { DataContext = new MainWindowViewModel() };
    window.Show();

    var add = window.FindControl<Button>("AddButton")!;

    Assert.False(add.IsEffectivelyEnabled);
}
```

:::warn title="Simulate input; don't call the command"
`addButton.Command!.Execute(null)` passes even if the button is invisible, covered or bound to the
wrong command. That's just a ViewModel test with extra steps. Use `KeyTextInput` and
`MouseDown`/`MouseUp` at the button's position so the test fails when a real user would fail.
Also note `IsEffectivelyEnabled`: a button whose command can't execute reports
`IsEnabled == true` but `IsEffectivelyEnabled == false`.
:::

:::info title="Which xUnit version?"
`Avalonia.Headless.XUnit` 12.x (what QuestBoard uses) works with **xUnit v3** (`xunit.v3`); the 11.x
package works with **xUnit v2** (`xunit` 2.9.x). Keep a UI test project on whatever version its
Avalonia.Headless package supports, and check the package's dependencies when you upgrade. NUnit fans can use `Avalonia.Headless.NUnit` with
`[AvaloniaTest]`.
:::

:::quiz id=dsk-11-q2 xp=10
A headless UI test is marked `[Fact]` instead of `[AvaloniaFact]` and fails as soon as it runs
`new MainWindow()`. Why?
- [ ] Headless tests need a monitor attached
- [x] Nothing has started the Avalonia headless app or its UI thread, and controls can only be created and used on that thread
- [ ] `[Fact]` tests can't reference other projects
- [ ] `MainWindow` must be created with `Activator.CreateInstance`
> `[AvaloniaFact]` starts the app built by your `AvaloniaTestApplication` builder once per session
> and **dispatches every test onto Avalonia's UI thread**. A plain `[Fact]` runs on an xUnit thread
> pool thread with no Avalonia app at all, so creating a control fails. No monitor is needed,
> because that's the whole point of headless. Project references work as normal.
:::

### MAUI UI testing at a glance: Appium

.NET MAUI has no in-process headless mode like Avalonia's. To test a MAUI app's real UI, teams use
**Appium**, an open-source automation server that drives apps through each platform's own
automation API. Your C# test talks to the Appium server over HTTP (the WebDriver protocol), and
Appium uses a **driver** for each platform:

| Platform | Appium driver | Underlying tool |
|---|---|---|
| Android | `uiautomator2` | Google's UiAutomator |
| iOS | `xcuitest` | Apple's XCUITest (needs a Mac) |
| Windows | `windows` / `novawindows` | Windows UI Automation |
| macOS (Mac Catalyst) | `mac2` | XCTest |

You find elements by **`AutomationId`**, a property you set on MAUI controls for exactly this
purpose (`<Button AutomationId="AddButton" … />`). A test (with the `Appium.WebDriver` NuGet
package) looks like this:

```csharp
var options = new AppiumOptions
{
    PlatformName = "Android",
    AutomationName = "UiAutomator2",
    App = "/path/to/com.companyname.questboard.mobile-Signed.apk",
};
using var driver = new AndroidDriver(new Uri("http://127.0.0.1:4723"), options);

driver.FindElement(MobileBy.Id("TitleEntry")).SendKeys("Slay the bug");
driver.FindElement(MobileBy.Id("AddButton")).Click();
Assert.Equal("1 quest", driver.FindElement(MobileBy.Id("StatusLabel")).Text);
```

On Android, MAUI turns `AutomationId` into the view's resource id, so `MobileBy.Id` finds it. On
Windows and iOS you look it up with `MobileBy.AccessibilityId("AddButton")` instead. Small shared
helpers usually hide that difference.

:::warn title="Appium client APIs move"
The `Appium.WebDriver` package has had several breaking major versions (class and option names
change). The snippet shows the shape of a test; copy exact setup code from the Appium .NET client
README and Microsoft's "UI testing .NET MAUI apps with Appium" guide for the versions you install.
:::

Setup is heavy: Node.js, `npm i -g appium`, `appium driver install uiautomator2`, a running emulator
or device. That's why teams keep Appium suites small (login, core flow, purchase) and run them
nightly rather than on every push. Testing the ViewModels, which are plain .NET classes in a shared
project, works for MAUI exactly as shown above.

:::job title="What you'll find in a real repo"
Most desktop/mobile teams have a `*.Tests` project with hundreds of ViewModel and service tests
that run on every pull request. Many have a small `*.UITests` project too (Avalonia.Headless for
Avalonia, Appium for MAUI or WPF) that runs on PRs or nightly. In your first week, run both locally,
and learn how to get the screenshots and logs out of a failed CI run.
:::

## Part 2: Shipping

### `dotnet publish`: the options that matter

`dotnet build` produces something that runs on **your** machine. `dotnet publish` produces a
folder you can **copy to someone else's** machine. Four decisions shape the result:

**1. Target (RID).** `-r win-x64`, `-r osx-arm64` (Apple silicon), `-r osx-x64` (Intel Macs),
`-r linux-x64`, `-r linux-arm64`. Native pieces such as Avalonia's Skia renderer differ per OS
and CPU, so each RID is a separate build.

**2. Framework-dependent vs self-contained.**

| | Framework-dependent (default) | Self-contained (`--self-contained`) |
|---|---|---|
| Needs .NET installed on the user's machine? | Yes, the matching .NET 10 runtime | No, the runtime is bundled |
| Size | Small (a few MB) | Large (70–100 MB before trimming) |
| Who patches .NET security bugs? | The user's machine (Windows Update, the package manager) | **You**, by shipping a new build |

Consumer apps almost always go **self-contained**: you can't ask users to install a runtime first.

**3. Single file.** `-p:PublishSingleFile=true` packs your DLLs into one executable. Native
libraries (`libSkiaSharp.so`, `libHarfBuzzSharp.so` on Linux) are still placed next to it unless
you add `-p:IncludeNativeLibrariesForSelfExtract=true`, which embeds them and extracts them on first
start.

**4. Trimming and Native AOT.**

- **Trimming** (`-p:PublishTrimmed=true`) removes unused code from the bundled framework and your
  libraries. In our lab build, QuestBoard drops from about 95 MB to about 34 MB. The catch: the trimmer finds "used"
  code by static analysis, so anything reached only through **reflection** (reflection-based
  `{Binding}`, some JSON serializers, DI scanning) can be removed, and the app breaks at runtime.
  **Treat every trim warning (`IL2026`, `IL2104`, …) as a bug.** Compiled bindings
  (`x:DataType`) and source generators (CommunityToolkit.Mvvm, `System.Text.Json` source
  generation) are what make trimming safe.
- **Native AOT** (`-p:PublishAot=true`) compiles the whole app to native machine code ahead of time:
  no JIT, faster start-up, lower memory. Avalonia (11 and 12) supports it. The caveats:
  - Everything trimming requires, but stricter: no runtime code generation and no loading plugins
    with `Assembly.LoadFrom`.
  - You must **build on the target OS**. A `win-x64` AOT binary comes from Windows and an `osx-arm64`
    one from macOS. (Plain self-contained publishes can cross-compile from any OS.)
  - It needs the platform's native toolchain: MSVC build tools on Windows, Xcode command-line
    tools on macOS, `clang` on Linux.

```bash
# The everyday desktop release build
dotnet publish QuestBoard -c Release -r win-x64 --self-contained \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=true
```

:::tip title="Put stable options in the .csproj"
Instead of long command lines, set `<PublishSingleFile>true</PublishSingleFile>`,
`<SelfContained>true</SelfContained>` and `<PublishTrimmed>true</PublishTrimmed>` in a
`<PropertyGroup Condition="'$(Configuration)' == 'Release'">` and pass only `-r <rid>`. You can
also create named **publish profiles** under `Properties/PublishProfiles/*.pubxml` and run them with
`-p:PublishProfile=win-x64`.
:::

:::quiz id=dsk-11-q3 xp=10
You publish QuestBoard **framework-dependent** for `win-x64` and email it to a tester. It won't
start on their fresh Windows laptop. What's the most likely cause?
- [ ] Framework-dependent builds only run on the machine that built them
- [x] The tester doesn't have the .NET 10 Desktop/runtime installed; a self-contained publish bundles it
- [ ] `win-x64` builds need Native AOT to start
- [ ] Single-file mode is required on Windows
> Framework-dependent means "I depend on a .NET runtime already being installed". A fresh machine
> usually doesn't have .NET 10, so the app host shows an error pointing to the download page.
> `--self-contained` bundles the runtime (bigger file, but it just runs). AOT and single-file are
> optional extras, not requirements.
:::

:::quiz id=dsk-11-q4 xp=15
Which statements about **trimming / Native AOT** are true? (Select all that apply.)
- [x] Code that's only reached through reflection can be removed by the trimmer, so trim warnings must be fixed, not ignored
- [x] Compiled bindings (`x:DataType`) and source generators help make an Avalonia app trim- and AOT-safe
- [ ] Native AOT lets you build `osx-arm64` binaries on a Linux CI runner
- [x] Native AOT apps start faster because there's no JIT compilation at start-up
- [ ] Trimming makes framework-dependent apps smaller
> The trimmer keeps what static analysis can see. Reflection-only paths vanish, and warnings like
> IL2026 tell you where. Compiled bindings and source generators replace reflection with generated
> code the analyser can follow. AOT does **not** cross-compile between operating systems (you need
> the target OS's native linker), which is why CI uses one runner per OS. Trimming only applies to
> **self-contained** publishes, because a framework-dependent app uses the shared runtime installed
> on the machine, which you can't trim.
:::

Now practise picking options for a whole release matrix.

:::challenge id=dsk-11-c2 lang=ts xp=50
title: Plan the publish matrix
Write `planPublish(target)` that turns a release target into the **runtime identifier**, the
**GitHub Actions runner** to build it on, and the **`dotnet` arguments**. QuestBoard has two
projects: the Avalonia desktop app at `src/QuestBoard` and the MAUI mobile app at
`src/QuestBoard.Mobile`.

| platform | rid | runner | args |
|---|---|---|---|
| `windows` | `win-<arch>` | `windows-latest` | desktop args |
| `macos` | `osx-<arch>` | `macos-latest` | desktop args |
| `linux` | `linux-<arch>` | `ubuntu-latest` | desktop args |
| `android` | `android-<arch>` | `windows-latest` | `['publish', 'src/QuestBoard.Mobile', '-c', 'Release', '-f', 'net10.0-android', '-p:AndroidPackageFormat=aab']` |
| `ios` | `ios-arm64` | `macos-latest` | `['publish', 'src/QuestBoard.Mobile', '-c', 'Release', '-f', 'net10.0-ios', '-r', 'ios-arm64']` |

**Desktop args** are `['publish', 'src/QuestBoard', '-c', 'Release', '-r', <rid>, '--self-contained', '-p:PublishSingleFile=true']`,
followed by `'-p:PublishTrimmed=true'` **only when** `target.trim` is true. `trim` is ignored for
Android and iOS (their Release builds always trim).

iOS devices are arm64 only: for `{ platform: 'ios', arch: 'x64' }` throw an `Error` whose
message contains `arm64`.

hint: Build the rid with a lookup object: `{ windows: 'win', macos: 'osx', linux: 'linux' }`.
hint: Use spread to add the optional flag: `...(target.trim ? ['-p:PublishTrimmed=true'] : [])`.
hint: Handle `android` and `ios` first with early returns, then share the desktop code.

```ts starter
type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios'
type Target = { platform: Platform; arch: 'x64' | 'arm64'; trim?: boolean }
type Plan = { rid: string; runner: string; args: string[] }

export function planPublish(target: Target): Plan {
  // TODO: follow the table
  return { rid: target.platform + '-' + target.arch, runner: 'ubuntu-latest', args: ['build'] }
}
```

```ts solution
type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios'
type Target = { platform: Platform; arch: 'x64' | 'arm64'; trim?: boolean }
type Plan = { rid: string; runner: string; args: string[] }

export function planPublish(target: Target): Plan {
  if (target.platform === 'android') {
    return {
      rid: `android-${target.arch}`,
      runner: 'windows-latest',
      args: ['publish', 'src/QuestBoard.Mobile', '-c', 'Release', '-f', 'net10.0-android', '-p:AndroidPackageFormat=aab'],
    }
  }
  if (target.platform === 'ios') {
    if (target.arch !== 'arm64') throw new Error('iOS devices are arm64 only')
    return {
      rid: 'ios-arm64',
      runner: 'macos-latest',
      args: ['publish', 'src/QuestBoard.Mobile', '-c', 'Release', '-f', 'net10.0-ios', '-r', 'ios-arm64'],
    }
  }
  const osPart = { windows: 'win', macos: 'osx', linux: 'linux' }[target.platform]
  const runner = { windows: 'windows-latest', macos: 'macos-latest', linux: 'ubuntu-latest' }[target.platform]
  const rid = `${osPart}-${target.arch}`
  return {
    rid,
    runner,
    args: [
      'publish', 'src/QuestBoard', '-c', 'Release', '-r', rid, '--self-contained',
      '-p:PublishSingleFile=true',
      ...(target.trim ? ['-p:PublishTrimmed=true'] : []),
    ],
  }
}
```

```ts tests
test('windows x64 desktop build', () => {
  expect(planPublish({ platform: 'windows', arch: 'x64' })).toEqual({
    rid: 'win-x64',
    runner: 'windows-latest',
    args: ['publish', 'src/QuestBoard', '-c', 'Release', '-r', 'win-x64', '--self-contained', '-p:PublishSingleFile=true'],
  })
})
test('macOS arm64 uses osx and a macOS runner', () => {
  const p = planPublish({ platform: 'macos', arch: 'arm64' })
  expect(p.rid).toBe('osx-arm64')
  expect(p.runner).toBe('macos-latest')
  expect(p.args).toContain('osx-arm64')
})
test('linux trimmed build adds the trim flag last', () => {
  const p = planPublish({ platform: 'linux', arch: 'arm64', trim: true })
  expect(p.rid).toBe('linux-arm64')
  expect(p.runner).toBe('ubuntu-latest')
  expect(p.args[p.args.length - 1]).toBe('-p:PublishTrimmed=true')
  expect(p.args).toHaveLength(9)
})
test('no trim flag unless asked', () => {
  expect(planPublish({ platform: 'windows', arch: 'arm64', trim: false }).args).not.toContain('-p:PublishTrimmed=true')
})
test('android builds an AAB from the mobile project and ignores trim', () => {
  expect(planPublish({ platform: 'android', arch: 'arm64', trim: true })).toEqual({
    rid: 'android-arm64',
    runner: 'windows-latest',
    args: ['publish', 'src/QuestBoard.Mobile', '-c', 'Release', '-f', 'net10.0-android', '-p:AndroidPackageFormat=aab'],
  })
})
test('ios arm64 builds on macOS', () => {
  expect(planPublish({ platform: 'ios', arch: 'arm64' })).toEqual({
    rid: 'ios-arm64',
    runner: 'macos-latest',
    args: ['publish', 'src/QuestBoard.Mobile', '-c', 'Release', '-f', 'net10.0-ios', '-r', 'ios-arm64'],
  })
})
test('ios x64 is rejected', () => {
  expect(() => planPublish({ platform: 'ios', arch: 'x64' })).toThrow('arm64')
})
```
:::

### Code signing: why the OS cares

When a user double-clicks a downloaded file, the OS asks two questions: **who made this?** and
**has it been tampered with since?** A code-signing signature answers both. It's a hash of the file
encrypted with the publisher's private key, plus a certificate from a trusted authority that
vouches for the publisher's identity. An unsigned app isn't necessarily malicious, but the OS can't
tell, so it warns:

- **Windows:** SmartScreen shows "Windows protected your PC" for unsigned or not-yet-reputable
  executables. You sign with `signtool` and a certificate from a certificate authority. Since 2023
  that certificate's private key must live on a hardware token or in a cloud **HSM** (hardware
  security module: a tamper-proof device that signs without ever revealing the key). The easier route
  is a cloud signing service such as Microsoft's Trusted Signing (now marketed as Azure Artifact
  Signing), which keeps the key for you.
- **macOS:** Gatekeeper refuses to open downloaded apps that aren't signed with an Apple
  **Developer ID** and **notarized** by Apple.
- **Android / iOS:** the stores require signed packages. You can't install an unsigned app at all.

:::warn title="Signing keys are crown jewels"
Whoever holds your signing key can ship "your" app. Never commit keys, keystores or `.p12` files.
Store them as **CI secrets** (base64-encoded files plus passwords), decode them only inside the
release job, and restrict that job to tagged builds on `main`.
:::

### Windows: MSIX and installers

Windows users expect a way to install and uninstall your app. The main options:

| Option | What it is | Good for |
|---|---|---|
| **MSIX** | Microsoft's modern package format: clean install/uninstall, per-user install, built-in updates, the Microsoft Store's preferred format (the Store also accepts `.exe`/`.msi` installers) | Store apps, managed enterprise deployment (Intune) |
| **Classic installer** (Inno Setup, WiX → `.msi`) | A `Setup.exe` / `.msi` that copies files and creates shortcuts | Traditional distribution, IT departments that want an `.msi` |
| **Velopack** | Generates `Setup.exe` **plus** delta auto-updates from your publish folder | Apps that update often (see below) |
| **Zip** | The single-file `.exe` in a zip | Internal tools, power users |

An MSIX must be signed by a certificate the machine trusts. The Microsoft Store re-signs packages
it distributes, so Store submissions only need a matching publisher identity in the manifest.

### macOS: the `.app` bundle, codesign and notarization

macOS apps are **bundles**: folders ending in `.app` that Finder shows as one icon.

```text
QuestBoard.app/
  Contents/
    Info.plist              ← bundle id, version, display name, icon name
    MacOS/QuestBoard        ← your published executable (osx-arm64 or osx-x64)
    Resources/QuestBoard.icns
```

You build it by publishing for `osx-arm64` (and/or `osx-x64`) and copying the output into
`Contents/MacOS`. Then a release on macOS takes three steps, **in this order**:

```bash
# 1. Sign every binary with your Developer ID and the hardened runtime.
#    .NET needs the JIT entitlement (com.apple.security.cs.allow-jit) unless you use Native AOT.
codesign --force --deep --timestamp --options runtime \
  --entitlements QuestBoard.entitlements \
  --sign "Developer ID Application: Your Name (TEAMID1234)" QuestBoard.app

# 2. Notarize: upload to Apple's automated malware scan and wait for the verdict.
ditto -c -k --keepParent QuestBoard.app QuestBoard.zip
xcrun notarytool submit QuestBoard.zip --keychain-profile "questboard-notary" --wait

# 3. Staple the notarization ticket into the bundle so it opens offline too.
xcrun stapler staple QuestBoard.app
```

Two words from that script:

- **Hardened runtime** (`--options runtime`): a macOS security mode that, among other things, forbids
  memory that is both writable and executable. Notarization requires it.
- **Entitlements**: a small XML file listing the exceptions your app needs. The .NET JIT writes
  machine code into memory at runtime, so a JIT-based .NET app must ask for that exception:

`QuestBoard.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
```

Then ship the `.app` inside a `.dmg` (disk image) or a zip. All three steps need macOS, which is
why the release matrix has a `macos-latest` job.

:::warn title="macOS signing details change; check the current docs"
Apple tightens these rules often, and the exact entitlement set depends on your app. Many .NET apps
also need `com.apple.security.cs.allow-unsigned-executable-memory` or
`com.apple.security.cs.disable-library-validation` (for example when single-file extracts native
`.dylib`s at startup). Apple recommends signing each nested binary inside-out rather than relying on
`--deep`. Before your first real release, follow Avalonia's "Deploying to macOS" guide and Apple's
"Notarizing macOS software before distribution" page, and run `spctl -a -vv QuestBoard.app` to see
what Gatekeeper thinks.
:::

:::quiz id=dsk-11-q5 xp=10
What's the correct order to prepare a downloadable macOS app?
- [ ] Notarize → sign → staple
- [x] Sign with Developer ID + hardened runtime → notarize → staple
- [ ] Staple → sign → notarize
- [ ] Sign → staple → notarize
> Apple notarizes **signed** binaries, so signing (with `--options runtime`, the hardened runtime)
> comes first. Notarization returns a ticket, and stapling attaches that ticket to the bundle so
> Gatekeeper can verify it offline. Changing the bundle after signing (even editing `Info.plist`)
> breaks the signature, so stapling is the only change allowed afterwards.
:::

### Linux: AppImage, Flatpak, deb

Linux has no single app store, so you pick formats by audience:

- **AppImage**: one self-contained file. The user runs `chmod +x QuestBoard-x86_64.AppImage` and
  starts it. There's no installation, and it works on most distributions. Built with
  `appimagetool` from an `AppDir` folder (your publish output + a `.desktop` file + an icon).
- **Flatpak**: sandboxed apps distributed through **Flathub**. You describe the build in a manifest
  (`com.devquest.QuestBoard.yml`) on top of a shared runtime (`org.freedesktop.Platform`). It's the
  closest thing to a cross-distro app store.
- **`.deb` / `.rpm`**: native packages for Debian/Ubuntu and Fedora/RHEL. They integrate with
  `apt`/`dnf` and are what enterprise Linux admins prefer. A `.deb` is your files under the
  install path plus a `DEBIAN/control` file, built with `dpkg-deb --build`:

```text
Package: questboard
Version: 1.0.0
Architecture: amd64
Maintainer: DevQuest <dev@example.com>
Description: A small quest tracker built with Avalonia
```

### Android: AAB and signing

Google Play requires an **Android App Bundle (`.aab`)** for new apps. It's a publishing format:
Play splits it into optimised APKs per device (CPU, screen density, language), so users download
less. An `.apk` is the installable file you sideload or use for testing.

Every Android package is signed with a key from a **keystore** file. With **Play App Signing**
(the default today), you sign uploads with your **upload key**, and Google re-signs with the
**app signing key** it keeps safe. If you lose the upload key, Google can reset it. Lose the key of
an app *without* Play App Signing, and you can never update that app again.

```bash
# Once: create an upload keystore (keep it out of git!)
keytool -genkeypair -v -keystore questboard-upload.keystore -alias questboard \
  -keyalg RSA -keysize 2048 -validity 10000

# Release build: signed AAB. Passwords come from environment variables via the env: prefix.
dotnet publish src/QuestBoard.Mobile -c Release -f net10.0-android \
  -p:AndroidPackageFormat=aab -p:AndroidKeyStore=true \
  -p:AndroidSigningKeyStore=questboard-upload.keystore -p:AndroidSigningKeyAlias=questboard \
  -p:AndroidSigningKeyPass=env:ANDROID_KEY_PASS -p:AndroidSigningStorePass=env:ANDROID_STORE_PASS
```

Every upload also needs a higher **`ApplicationVersion`** (the integer `versionCode`) than the last
one, and Play rejects duplicates. CI usually sets it from the build number:
`-p:ApplicationVersion=${{ github.run_number }}`.

:::info title="MAUI builds don't run on Linux"
The MAUI workload (`dotnet workload install maui`) is supported on **Windows and macOS only**. You
can't build the MAUI QuestBoard on a Linux machine, so CI uses `windows-latest` (or macOS) for
Android and `macos-latest` with Xcode for iOS. Avalonia, by contrast, publishes desktop builds from
any OS.
:::

### iOS: archive, signing and TestFlight

iOS is the strictest platform. Before your first build you need:

1. An **Apple Developer Program** membership (paid, yearly).
2. A **distribution certificate** (who you are) and a **provisioning profile** (which app id may run
   where, signed by Apple), both created in the Apple Developer portal or managed automatically by
   Xcode.
3. A **Mac with Xcode**. The iOS toolchain only runs on macOS.

`dotnet publish -f net10.0-ios -c Release -r ios-arm64` (plus `-p:CodesignKey=…` and
`-p:CodesignProvision=…`) produces a signed **`.ipa`**, the iOS archive. Upload it to **App Store
Connect** (with Apple's Transporter app or a CI action). From there it goes to **TestFlight**,
Apple's beta channel:

- **Internal testers** (up to 100 members of your App Store Connect team) get builds right away.
- **External testers** (up to 10,000 by email or public link) need a quick **Beta App Review** for
  the first build of a version.

:::quiz id=dsk-11-q6 xp=10
The Android **upload keystore** for QuestBoard is lost. The app is enrolled in **Play App Signing**.
What happens?
- [ ] The app can never be updated again; you must publish a new app with a new package name
- [x] You generate a new upload key and ask Google to reset the upload key; users keep receiving updates because Google holds the app signing key
- [ ] Nothing: Play accepts unsigned AABs for existing apps
- [ ] You re-sign the AAB with the debug keystore
> With Play App Signing, Google keeps the **app signing key**, the one users' devices trust. Your
> upload key only proves to Google that an upload came from you, so it can be reset through Play
> Console support. Without Play App Signing, losing the key really would mean no more updates,
> which is why it's the default. Play never accepts unsigned or debug-signed release uploads.
:::

### Auto-update with Velopack

Web apps update themselves. Desktop users often never download a new version manually, so you'd
end up supporting very old builds forever. **Velopack** is an open-source installer and update
framework for desktop .NET apps (Windows, macOS, Linux). It turns your publish folder into an
installer plus **delta packages**, which contain only the bytes that changed. It also checks for and
applies updates from any static file host (GitHub Releases, S3, a CDN).

On the build side:

```bash
dotnet tool install -g vpk
dotnet publish src/QuestBoard -c Release -r win-x64 --self-contained -o publish/win-x64
vpk pack --packId QuestBoard --packVersion 1.2.0 --packDir publish/win-x64 --mainExe QuestBoard.exe
# → Releases/QuestBoard-win-Setup.exe, QuestBoard-1.2.0-full.nupkg, (delta) nupkg, releases.win.json
```

Keep the `vpk` tool and the `Velopack` NuGet package on the **same version**; mismatches are a
common source of broken updates. Exact flags and output names change between releases, so check
`vpk pack --help` and the Velopack docs (docs.velopack.io) for the version you install.

In the app (NuGet package `Velopack`):

```csharp
public static void Main(string[] args)
{
    VelopackApp.Build().Run();   // must be the FIRST line: handles install/update hooks, then returns
    BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
}

// e.g. from a "Check for updates" command in a ViewModel
private static async Task UpdateIfAvailableAsync()
{
    var mgr = new UpdateManager("https://downloads.example.com/questboard");
    var update = await mgr.CheckForUpdatesAsync();
    if (update is null) return;                  // already up to date
    await mgr.DownloadUpdatesAsync(update);
    mgr.ApplyUpdatesAndRestart(update);
}
```

Mobile apps don't need this, because the App Store and Play Store handle updates. MSIX and Store
apps also update through Windows.

:::quiz id=dsk-11-q7 xp=10
Why must `VelopackApp.Build().Run()` be the **first** line in `Main`?
- [ ] It downloads the latest version before the UI starts
- [x] During install, update and uninstall, Velopack starts your exe with special arguments; `Run()` handles those hooks and exits before any UI or other startup code runs
- [ ] Avalonia needs it to initialise Skia
- [ ] It's only needed in Debug builds
> Velopack's installer and updater call your executable with hook arguments (first install, after an
> update, before uninstall). `Run()` detects them, runs your optional callbacks and exits quickly.
> If your app opened a window or a database first, those hooks would hang or misbehave. It doesn't
> download anything by itself. Checking for updates is a separate, explicit `UpdateManager` call.
:::

### CI: one workflow, a matrix of operating systems

A GitHub Actions **matrix** runs the same job several times with different values, here one per
target OS. Tests run once on fast Linux (headless means no display needed), then each OS builds its
own release:

```yaml
name: desktop-release
on:
  push:
    tags: ['v*']

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: '10.0.x'
      - run: dotnet test -c Release
      - uses: actions/upload-artifact@v5
        if: failure()
        with:
          name: ui-test-screenshots
          path: '**/bin/Release/**/*.png'

  publish:
    needs: test
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: windows-latest, rid: win-x64 }
          - { os: macos-latest,   rid: osx-arm64 }
          - { os: ubuntu-latest,  rid: linux-x64 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: '10.0.x'
      - run: >
          dotnet publish src/QuestBoard -c Release -r ${{ matrix.rid }} --self-contained
          -p:PublishSingleFile=true -p:PublishTrimmed=true -o out/${{ matrix.rid }}
      # Signing / packaging steps per OS go here (signtool, codesign+notarytool, appimagetool, vpk pack)
      - uses: actions/upload-artifact@v5
        with:
          name: questboard-${{ matrix.rid }}
          path: out/${{ matrix.rid }}
```

Key ideas: `needs: test` stops a broken build from being published. `fail-fast: false` lets the
other OSes finish when one fails, so you see every problem at once. And `include` lists exactly the
combinations you want instead of a full cross product.

:::quiz id=dsk-11-q8 xp=10
Avalonia can cross-publish a self-contained `osx-arm64` build from Linux. Why does the release
matrix still use a `macos-latest` runner for the Mac build?
- [ ] Linux runners can't run `dotnet publish`
- [x] Signing with `codesign`, notarizing with `notarytool` and building Native AOT for macOS all need macOS tools
- [ ] GitHub Actions forbids publishing macOS builds from Linux
- [ ] The `osx-arm64` RID only exists on macOS
> The *compile* can happen anywhere, but a Mac release isn't just a compile. `codesign`,
> `xcrun notarytool`, `stapler`, `.dmg` creation and the native linker Native AOT needs are Apple
> tools that only run on macOS. Running the whole Mac job on `macos-latest` keeps it in one place.
> RIDs are just names and exist on every OS.
:::

:::pro title="What seniors set up once and reuse"
- **Versioning from git tags:** one version number (`v1.4.2`) flows into `-p:Version`, the Android
  `ApplicationVersion`, the iOS bundle version and `vpk --packVersion`. Tools like MinVer or
  Nerdbank.GitVersioning do this for you.
- **Smoke-test the published artifact,** not just the build output. For example, start the
  self-contained binary with a `--smoke-test` flag that opens the main window headlessly and exits 0.
  Trimming bugs only appear in the published build.
- **Staged rollouts:** Play's percentage rollout, TestFlight before App Store, a Velopack "beta"
  channel before "stable". Ship to 5 % first and watch crash reports (Sentry, App Center's
  successors, Firebase Crashlytics) before going to 100 %.
:::

## Lab

:::lab id=dsk-11-lab1 xp=100
title: Headless-test and publish QuestBoard for your OS
You'll create a small QuestBoard solution (an Avalonia app plus a test project), write ViewModel
tests and a headless UI test that types, clicks and saves a screenshot, then publish a
self-contained single-file build for **your** OS. If you already have QuestBoard from earlier
lessons, you can add the test project to it instead. Just keep the `x:Name`s used below.

**Prerequisites:** .NET 10 SDK (`dotnet --version` shows `10.0.x`), internet access for NuGet.
Works on Windows, macOS and Linux.
(Verified with the .NET 10 SDK, Avalonia 12.1.5 and `xunit.v3` 3.2.2: 4/4 tests,
screenshot saved.)

**1. Create the folders and solution**

```bash
mkdir QuestBoardLab && cd QuestBoardLab
mkdir -p QuestBoard/ViewModels QuestBoard/Views QuestBoard.Tests
```

(On Windows PowerShell, `mkdir` creates the parent folders automatically. Run
`mkdir QuestBoard/ViewModels, QuestBoard/Views, QuestBoard.Tests`.)

**2. The app project**: `QuestBoard/QuestBoard.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AvaloniaUseCompiledBindingsByDefault>true</AvaloniaUseCompiledBindingsByDefault>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Avalonia" Version="12.1.5" />
    <PackageReference Include="Avalonia.Desktop" Version="12.1.5" />
    <PackageReference Include="Avalonia.Themes.Fluent" Version="12.1.5" />
    <PackageReference Include="Avalonia.Fonts.Inter" Version="12.1.5" />
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.2" />
  </ItemGroup>
</Project>
```

`QuestBoard/Program.cs`

```csharp
using Avalonia;

namespace QuestBoard;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args) =>
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
```

`QuestBoard/App.axaml`

```xml
<Application xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             x:Class="QuestBoard.App"
             RequestedThemeVariant="Default">
  <Application.Styles>
    <FluentTheme />
  </Application.Styles>
</Application>
```

`QuestBoard/App.axaml.cs`

```csharp
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using QuestBoard.ViewModels;
using QuestBoard.Views;

namespace QuestBoard;

public partial class App : Application
{
    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = new MainWindow { DataContext = new MainWindowViewModel() };
        }
        base.OnFrameworkInitializationCompleted();
    }
}
```

`QuestBoard/ViewModels/MainWindowViewModel.cs`

```csharp
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace QuestBoard.ViewModels;

public partial class MainWindowViewModel : ObservableObject
{
    public ObservableCollection<string> Quests { get; } = new();

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]
    private string _newTitle = "";

    [ObservableProperty]
    private string _status = "No quests yet";

    private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewTitle);

    [RelayCommand(CanExecute = nameof(CanAddQuest))]
    private void AddQuest()
    {
        Quests.Add(NewTitle.Trim());
        NewTitle = "";
        Status = Quests.Count == 1 ? "1 quest" : $"{Quests.Count} quests";
    }
}
```

`QuestBoard/Views/MainWindow.axaml`

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.ViewModels"
        x:Class="QuestBoard.Views.MainWindow"
        x:DataType="vm:MainWindowViewModel"
        Title="QuestBoard" Width="420" Height="360">
  <DockPanel Margin="16">
    <StackPanel DockPanel.Dock="Top" Orientation="Horizontal" Spacing="8">
      <TextBox x:Name="TitleBox" Width="260" PlaceholderText="New quest…"
               Text="{Binding NewTitle}" />
      <Button x:Name="AddButton" Content="Add" Command="{Binding AddQuestCommand}" />
    </StackPanel>
    <TextBlock x:Name="StatusText" DockPanel.Dock="Bottom" Text="{Binding Status}" />
    <ListBox x:Name="QuestList" Margin="0,12" ItemsSource="{Binding Quests}" />
  </DockPanel>
</Window>
```

`QuestBoard/Views/MainWindow.axaml.cs`

```csharp
using Avalonia.Controls;

namespace QuestBoard.Views;

public partial class MainWindow : Window
{
    public MainWindow() => InitializeComponent();
}
```

**3. The test project**: `QuestBoard.Tests/QuestBoard.Tests.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.1" />
    <PackageReference Include="xunit.v3" Version="3.2.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" />
    <PackageReference Include="Avalonia.Headless.XUnit" Version="12.1.5" />
    <PackageReference Include="Avalonia.Skia" Version="12.1.5" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\QuestBoard\QuestBoard.csproj" />
  </ItemGroup>
</Project>
```

`QuestBoard.Tests/TestAppBuilder.cs`: tells Avalonia.Headless how to build the app for tests.

```csharp
using Avalonia;
using Avalonia.Headless;

[assembly: AvaloniaTestApplication(typeof(QuestBoard.Tests.TestAppBuilder))]

namespace QuestBoard.Tests;

public class TestAppBuilder
{
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UseSkia()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false });
}
```

`QuestBoard.Tests/MainWindowViewModelTests.cs`: plain, fast ViewModel tests.

```csharp
using QuestBoard.ViewModels;
using Xunit;

namespace QuestBoard.Tests;

public class MainWindowViewModelTests
{
    [Fact]
    public void Add_is_disabled_while_title_is_blank()
    {
        var vm = new MainWindowViewModel { NewTitle = "   " };

        Assert.False(vm.AddQuestCommand.CanExecute(null));
    }

    [Fact]
    public void Typing_a_title_raises_CanExecuteChanged()
    {
        var vm = new MainWindowViewModel();
        var raised = 0;
        vm.AddQuestCommand.CanExecuteChanged += (_, _) => raised++;

        vm.NewTitle = "Slay the bug";

        Assert.True(raised > 0);
        Assert.True(vm.AddQuestCommand.CanExecute(null));
    }

    [Fact]
    public void Adding_trims_clears_input_and_updates_status()
    {
        var vm = new MainWindowViewModel { NewTitle = "  Slay the bug  " };
        var changed = new List<string?>();
        vm.PropertyChanged += (_, e) => changed.Add(e.PropertyName);

        vm.AddQuestCommand.Execute(null);

        Assert.Equal(["Slay the bug"], vm.Quests);
        Assert.Equal("", vm.NewTitle);
        Assert.Equal("1 quest", vm.Status);
        Assert.Contains(nameof(vm.Status), changed);
    }
}
```

`QuestBoard.Tests/MainWindowUiTests.cs`: a real window, real keyboard and mouse input, a
screenshot.

```csharp
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.VisualTree;
using QuestBoard.ViewModels;
using QuestBoard.Views;
using Xunit;

namespace QuestBoard.Tests;

public class MainWindowUiTests
{
    [AvaloniaFact]
    public void Typing_and_clicking_Add_shows_the_quest()
    {
        var window = new MainWindow { DataContext = new MainWindowViewModel() };
        window.Show();

        var titleBox = window.FindControl<TextBox>("TitleBox")!;
        var addButton = window.FindControl<Button>("AddButton")!;
        var list = window.FindControl<ListBox>("QuestList")!;
        var status = window.FindControl<TextBlock>("StatusText")!;

        Assert.False(addButton.IsEffectivelyEnabled);

        titleBox.Focus();
        window.KeyTextInput("Slay the bug");
        Assert.True(addButton.IsEffectivelyEnabled);

        var center = addButton.TranslatePoint(
            new Point(addButton.Bounds.Width / 2, addButton.Bounds.Height / 2), window)!.Value;
        window.MouseDown(center, MouseButton.Left);
        window.MouseUp(center, MouseButton.Left);

        Assert.Equal(1, list.ItemCount);
        Assert.Equal("1 quest", status.Text);
        Assert.Equal("", titleBox.Text);

        var frame = window.CaptureRenderedFrame();
        Assert.NotNull(frame);
        frame!.Save("questboard-after-add.png", new PngBitmapEncoderOptions());
    }
}
```

**4. Wire up the solution and run the tests** (from `QuestBoardLab/`)

```bash
dotnet new sln -n QuestBoard
dotnet sln add QuestBoard QuestBoard.Tests
dotnet test
```

On .NET 10, `dotnet new sln` creates `QuestBoard.slnx` (the newer XML solution format) instead of
`QuestBoard.sln`. Both work the same with `dotnet sln` and `dotnet test`.

Expected output (the end of it; the wording is translated if your SDK uses another language):

```text
Passed!  - Failed:     0, Passed:     4, Skipped:     0, Total:     4, Duration: 549 ms - QuestBoard.Tests.dll (net10.0)
```

Open `QuestBoard.Tests/bin/Debug/net10.0/questboard-after-add.png`. You should see the window with
an empty text box, a disabled **Add** button, "Slay the bug" in the list and "1 quest" at the
bottom. That picture was rendered with no window ever appearing on your screen.

:::tip title="Prove the test can fail"
Temporarily remove `[NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]` from the ViewModel and
run `dotnet test` again. Both `Typing_a_title_raises_CanExecuteChanged` and the UI test should go
red (the button never becomes enabled, so the click does nothing). Put the attribute back.
:::

**5. Publish for your OS**

Pick the line for your machine. Use `osx-x64` on an Intel Mac and `linux-arm64` / `win-arm64` on
ARM machines.

```bash
# Linux
dotnet publish QuestBoard -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=true -o publish/linux-x64

# Windows
dotnet publish QuestBoard -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=true -o publish/win-x64

# macOS (Apple silicon)
dotnet publish QuestBoard -c Release -r osx-arm64 --self-contained -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=true -o publish/osx-arm64
```

Expected: the command ends with `QuestBoard -> …/publish/<rid>/` and **no trim warnings**
(`IL2xxx`). The folder contains `QuestBoard` (`QuestBoard.exe` on Windows) and `QuestBoard.pdb`.
The executable is roughly **30–35 MB**. Run the publish once more without `-p:PublishTrimmed=true`
into another folder to compare: about **95 MB**. (Measured on linux-x64; other RIDs differ by a
few MB.)

Start it: `./publish/linux-x64/QuestBoard`, `.\publish\win-x64\QuestBoard.exe` or
`./publish/osx-arm64/QuestBoard`. Add two quests and check that the status says "2 quests". Copy the
file to another machine with the same OS (no .NET installed) and it still runs, because the runtime
is bundled.

:::info title="Unsigned on purpose"
This build isn't signed. Running it locally is fine, but Windows SmartScreen or macOS Gatekeeper
would warn a user who downloaded it. Signing and notarization need paid certificates, as described
above.
:::

- [ ] `dotnet test` reports 4 passed, 0 failed
- [ ] `questboard-after-add.png` shows the quest in the list and "1 quest"
- [ ] Removing `[NotifyCanExecuteChangedFor]` turns tests red, and restoring it turns them green
- [ ] `dotnet publish` for my RID finishes with no `IL2xxx` trim warnings
- [ ] The published single-file app starts, and adding two quests shows "2 quests"
- [ ] I compared the trimmed and untrimmed sizes
:::

:::quiz id=dsk-11-q9 xp=10
In the lab's UI test, why is the button's centre computed with `TranslatePoint` instead of calling
`addButton.Command.Execute(null)`?
- [ ] `Command.Execute` doesn't exist on Avalonia buttons
- [x] A simulated click at the button's real position only works if the button is visible, enabled and hit-testable, so the test fails the way a user would
- [ ] Headless mode ignores commands
- [ ] `TranslatePoint` makes the test run faster
> Calling the command directly skips the view: it would pass even if the button were hidden, covered
> or bound to the wrong command. Sending `MouseDown`/`MouseUp` to the window at the button's
> coordinates goes through hit-testing and the button's own click logic, the same path a real
> click takes. That's what a UI test is for.
:::

:::cards id=dsk-11-cards1 xp=20 title="Testing & shipping desktop/mobile"
Q: What belongs in ViewModel unit tests vs headless UI tests?
A: ViewModel tests: logic, CanExecute edge cases, change notifications (many, fast). UI tests: wiring of bindings and commands for key flows (few, slower).
Q: What does `[AvaloniaFact]` do?
A: Starts the headless Avalonia app (from the AvaloniaTestApplication builder) and runs the test on Avalonia's UI thread.
Q: How do you get a screenshot from a headless test?
A: `window.CaptureRenderedFrame()`. It needs `.UseSkia()` and `UseHeadlessDrawing = false`.
Q: Self-contained vs framework-dependent?
A: Self-contained bundles the .NET runtime (bigger, runs anywhere, you ship runtime patches). Framework-dependent needs .NET installed.
Q: Main risk of trimming / Native AOT?
A: Code reached only via reflection gets removed. Fix every IL2xxx warning; use compiled bindings and source generators. AOT must be built on the target OS.
Q: macOS release steps?
A: Build the .app bundle → codesign with Developer ID + hardened runtime (`--options runtime`) → `notarytool submit --wait` → `stapler staple`.
Q: Why AAB instead of APK for Google Play?
A: Play requires AABs for new apps and splits them into optimised per-device APKs. With Play App Signing a lost upload key can be reset.
Q: Internal vs external TestFlight testers?
A: Internal: up to 100 team members, no review. External: up to 10,000 testers, needs Beta App Review.
Q: What does Velopack give a desktop app?
A: An installer plus delta auto-updates from a static host. `VelopackApp.Build().Run()` first in Main, `UpdateManager` to check, download and apply.
Q: Why can't you build a MAUI app on Linux?
A: The MAUI workload only supports Windows and macOS. CI uses windows/macos runners; iOS needs macOS + Xcode.
:::

## Recap

- Test from the bottom of the pyramid: many fast **xUnit ViewModel tests** (state, `CanExecute`,
  change notifications), a few **Avalonia.Headless** UI tests with `[AvaloniaFact]`, real input and
  screenshots, and a small **Appium** suite for MAUI and device smoke tests.
- `dotnet publish -r <rid> --self-contained -p:PublishSingleFile=true` produces a copy-anywhere
  build. Trimming shrinks it a lot but punishes reflection. Native AOT is faster but must be built on
  the target OS.
- Signing proves who built a file: `signtool`/MSIX on Windows, `codesign` → notarize → staple on
  macOS, keystores for Android, certificates + provisioning profiles for iOS. Keep keys in CI
  secrets.
- Package for each platform: MSIX or installers on Windows, `.app`/`.dmg` on macOS,
  AppImage/Flatpak/deb on Linux, AAB for Google Play, `.ipa` → TestFlight → App Store for iOS.
- **Velopack** adds installers and delta auto-updates to desktop apps. The stores handle mobile
  updates.
- One GitHub Actions workflow: tests on Linux (headless needs no display), then a **matrix** with
  one publish job per OS. Mac and iOS jobs run on macOS, and MAUI never builds on Linux.
