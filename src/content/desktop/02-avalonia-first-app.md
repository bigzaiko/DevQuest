---
id: dsk-03
title: Your First Avalonia App
level: beginner
minutes: 75
xp: 100
summary: Install the Avalonia templates, create the QuestBoard app, understand every generated file, and add your first button that adds a quest.
---

In **XAML & Desktop C# Primer** you met XAML, and **The .NET UI Landscape** introduced MVVM on paper. Now you build a real desktop app
that opens a real window on Windows, macOS **and** Linux, from one codebase. That app is
**QuestBoard**, a small quest (task) tracker. You'll grow it through the whole region, and the boss
fight reuses everything to build a BranchStory reader client.

## Why Avalonia?

A **UI framework** is the library that draws windows, buttons and text boxes and turns mouse and
keyboard input into events your code can handle. On .NET you have several:

| Framework | Runs on | Typical use |
|---|---|---|
| WPF | Windows only | Older line-of-business apps (huge installed base) |
| WinUI 3 | Windows only | New Windows-only apps |
| .NET MAUI | Windows, macOS, Android, iOS (not Linux) | Mobile-first apps that use native controls |
| **Avalonia** | Windows, macOS, Linux, Android, iOS, browser (WASM) | Cross-platform desktop apps, porting WPF apps |

Avalonia **draws every pixel itself** (with **Skia**, the open-source 2D graphics library that also
draws Chrome's pages and Android's UI), much like a game engine or a browser does. It doesn't wrap the operating system's buttons. That brings two things:

- **It looks and behaves the same everywhere.** A layout bug you fix on Linux is fixed on Windows too.
- **It runs where Microsoft's frameworks don't.** Linux desktops, embedded screens, kiosks.

Its XAML is very close to WPF's, so WPF knowledge carries over, and so does this course's knowledge
to WPF. Companies such as JetBrains and Unity use Avalonia for parts of their own desktop tools.

:::job title="What you'll meet at work"
Avalonia jobs usually mean one of two things: a **cross-platform desktop product** (engineering tools,
trading terminals, medical devices, internal admin apps), or a **WPF app being ported** so it runs on
macOS/Linux. In both, you're expected to know the MVVM layout this template generates, and to work
with ViewModels that unit tests can cover without a window.
:::

:::info title="Versions used in this lesson"
.NET 10 SDK, the current Avalonia templates (at the time of writing they generate **Avalonia 12.x**
projects; many existing codebases are still on **11.x**, which is nearly identical for everything in
this lesson; the differences are called out), and **CommunityToolkit.Mvvm 8.4**.
:::

## Step 1: templates

A **project template** is a ready-made starter project that `dotnet new` copies and renames for you.
.NET ships templates for console apps and web APIs. Avalonia's templates come as a separate
**template package** you install once per machine:

```bash
dotnet new install Avalonia.Templates
```

Afterwards `dotnet new list avalonia` shows the new templates (the package also contains page,
style and control templates you'll meet later). The ones you'll use:

| Short name | What it creates |
|---|---|
| `avalonia.app` | Minimal app: one window, code-behind, no MVVM |
| `avalonia.mvvm` | App with Views, ViewModels, a ViewLocator and CommunityToolkit.Mvvm |
| `avalonia.xplat` | Several projects: shared code + Desktop, Android, iOS, Browser heads |
| `avalonia.window` / `avalonia.usercontrol` | One new item (an `.axaml` + `.axaml.cs` pair) inside an existing project |

**Project** templates (`app`, `mvvm`, `xplat`) create a whole new project; **item** templates add one
file pair to the project you're standing in, for example (run inside the project folder):

```bash
dotnet new avalonia.window -n SettingsWindow -o Views   # → Views/SettingsWindow.axaml + .axaml.cs
```

To update later, run the same `dotnet new install Avalonia.Templates` again.

## Step 2: create QuestBoard

```bash
dotnet new avalonia.mvvm -o QuestBoard
cd QuestBoard
dotnet run
```

`-o QuestBoard` means "output into a new folder called QuestBoard", and the project and namespace
take that name too. `dotnet run` **restores** (downloads the
NuGet packages the project lists; **NuGet** is .NET's package registry, like npm for JavaScript),
compiles, and starts the app. A window
titled **QuestBoard** opens with a text box saying *Welcome to Avalonia!*

:::quiz id=dsk-03-q1 xp=10
You want a new cross-platform desktop app that follows MVVM from day one. Which command?
- [ ] `dotnet new avalonia.app -o QuestBoard`
- [x] `dotnet new avalonia.mvvm -o QuestBoard`
- [ ] `dotnet new avalonia.window -o QuestBoard`
- [ ] `dotnet new install avalonia.mvvm`
> `avalonia.mvvm` generates the Views/ViewModels folders, a `ViewLocator` and the CommunityToolkit.Mvvm
> package. `avalonia.app` is the minimal code-behind starter. `avalonia.window` only adds one window
> to an existing project. `dotnet new install` installs a template *package*, it doesn't create a project.
:::

## Step 3: what got generated

```text
QuestBoard/
├── QuestBoard.csproj        ← project file: target framework + NuGet packages
├── Program.cs               ← entry point: builds and starts the Avalonia app
├── App.axaml                ← application-wide XAML: theme, global data templates
├── App.axaml.cs             ← application class: creates the main window
├── ViewLocator.cs           ← finds the View for a ViewModel by naming convention
├── app.manifest             ← Windows-only settings (ignored on macOS/Linux)
├── Assets/avalonia-logo.ico ← window icon
├── Models/                  ← listed in the .csproj but not created on disk: make it for your data classes
├── ViewModels/
│   ├── ViewModelBase.cs     ← base class for all ViewModels
│   └── MainViewModel.cs     ← state + logic for the main window
└── Views/
    ├── MainWindow.axaml     ← what the main window looks like (XAML)
    └── MainWindow.axaml.cs  ← code-behind for that window
```

`.axaml` is Avalonia's file extension for XAML. It's the same XML language, just a different
extension, so IDEs don't confuse it with WPF's `.xaml`. Let's walk through the files in the order they run.

### The project file

```xml
<OutputType>WinExe</OutputType>
<TargetFramework>net10.0</TargetFramework>
...
<PackageReference Include="Avalonia" Version="12.1.5" />
<PackageReference Include="Avalonia.Desktop" Version="12.1.5" />
<PackageReference Include="Avalonia.Themes.Fluent" Version="12.1.5" />
<PackageReference Include="Avalonia.Fonts.Inter" Version="12.1.5" />
<PackageReference Include="AvaloniaUI.DiagnosticsSupport" Version="2.2.3" ... />
<PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.2" />
```

- `WinExe` means "a GUI app". On Windows it stops a black console window from opening next to
  yours. On macOS/Linux it behaves like a normal executable.
- `Avalonia` is the core framework. `Avalonia.Desktop` adds the Windows/macOS/Linux back-ends.
  `Themes.Fluent` is the look (Microsoft's Fluent design). `Fonts.Inter` bundles the Inter font so text
  looks the same on every OS.
- `AvaloniaUI.DiagnosticsSupport` connects your app to the Developer Tools (more on that below). It's
  only included in **Debug** builds.
- `CommunityToolkit.Mvvm` is Microsoft's MVVM helper library, which writes boilerplate for you.

### Program.cs: the entry point

```csharp
sealed class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp()
        .StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
#if DEBUG
            .WithDeveloperTools()
#endif
            .WithInterFont()
            .LogToTrace();
}
```

Read it top to bottom:

- `Main` is where every .NET program starts. `[STAThread]` is a Windows requirement for UI threads
  (clipboard, drag & drop). Keep it.
- `AppBuilder.Configure<App>()` says "my application class is `App`".
- `UsePlatformDetect()` picks the right **platform back-end** (the layer that asks the operating
  system for a window and receives its mouse/keyboard events) at runtime: Win32 on Windows, the native back-end on
  macOS, X11 on Linux. This is why one codebase runs everywhere.
- `#if DEBUG … #endif` is a **compiler directive**. That line only exists in Debug builds, so the dev
  tools never ship to users.
- `LogToTrace()` sends Avalonia's internal warnings (binding errors!) to the debug output.
- `StartWithClassicDesktopLifetime(args)` starts the app and **blocks** until it shuts down.

`BuildAvaloniaApp` is a separate method because the IDE previewer calls it too, to render your XAML
without running `Main`. Don't rename or delete it.

:::warn title="Nothing Avalonia-related before Main starts the app"
The template comment says it: don't touch Avalonia APIs (or anything relying on the UI thread) before
`StartWithClassicDesktopLifetime` runs. Avalonia isn't initialised yet, so things fail in confusing ways.
Put startup logic in `App.OnFrameworkInitializationCompleted` instead.
:::

### The application lifetime

An **application lifetime** is the object that decides *how the app lives and dies*: what the
"main" window is, and when the process should exit. Different platforms need different models:

| Lifetime | Used on | Idea |
|---|---|---|
| `IClassicDesktopStyleApplicationLifetime` | Windows, macOS, Linux | You have windows; by default the app exits when the **last window closes** (`ShutdownMode`) |
| `ISingleViewApplicationLifetime` | Android, iOS, browser | No windows, just one root view filling the screen |

`StartWithClassicDesktopLifetime` picks the first. Then `App` checks which one it got:

```csharp
public partial class App : Application
{
    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);   // reads App.axaml
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = new MainWindow
            {
                DataContext = new MainViewModel(),
            };
        }

        base.OnFrameworkInitializationCompleted();
    }
}
```

- `partial class` means the class is split over several files. The XAML compiler writes the other half
  from `App.axaml`.
- `Initialize()` loads the XAML (theme, data templates).
- `OnFrameworkInitializationCompleted()` runs once Avalonia is ready. It's the place to create
  your first window and wire up services.
- `ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop` is C# **pattern matching**:
  "if the lifetime is the desktop kind, call it `desktop` and run the block".
- `DataContext = new MainViewModel()` connects View and ViewModel. Every `{Binding …}` in the
  window looks up its path on this object.

So the startup chain is: `Main` → `AppBuilder` → lifetime → `App.Initialize` → `App.OnFrameworkInitializationCompleted`
→ `MainWindow` shown → the app runs until the last window closes.

:::quiz id=dsk-03-q2 xp=10
Where should you create the main window and set its `DataContext`?
- [ ] In `Program.Main`, before `StartWithClassicDesktopLifetime`
- [x] In `App.OnFrameworkInitializationCompleted`
- [ ] In the `MainWindow` constructor
- [ ] In `App.axaml`
> When `OnFrameworkInitializationCompleted` runs, Avalonia is initialised and the lifetime is known,
> so it's the right place to build windows. In `Main` it's too early: Avalonia isn't running yet.
> Creating the ViewModel inside the window's constructor ties the View to one concrete ViewModel,
> which makes testing and dependency injection harder.
:::

:::quiz id=dsk-03-q3 xp=10
With the classic desktop lifetime and default settings, when does the process exit?
- [ ] When `Main` returns immediately after starting
- [x] When the last open window is closed
- [ ] Only when you call `Environment.Exit`
- [ ] When the main window loses focus
> The default `ShutdownMode` is `OnLastWindowClose`. You can switch to `OnMainWindowClose` or
> `OnExplicitShutdown` (for tray apps) via `desktop.ShutdownMode`. `StartWithClassicDesktopLifetime`
> *blocks*, which is why `Main` doesn't return early.
:::

### App.axaml: app-wide XAML

```xml
<Application xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             x:Class="QuestBoard.App"
             xmlns:local="using:QuestBoard"
             RequestedThemeVariant="Default">
    <Application.DataTemplates>
        <local:ViewLocator />
    </Application.DataTemplates>
    <Application.Styles>
        <FluentTheme />
    </Application.Styles>
</Application>
```

- `xmlns="https://github.com/avaloniaui"` makes Avalonia's controls (`Window`, `Button`, …) available
  without a prefix. `xmlns:x` is the XAML language itself (`x:Class`, `x:DataType`).
- `xmlns:local="using:QuestBoard"` maps the prefix `local:` to your C# namespace, so `<local:ViewLocator />`
  means `new QuestBoard.ViewLocator()`.
- `x:Class="QuestBoard.App"` links this XAML to the C# class of the same name.
- `RequestedThemeVariant="Default"` follows the OS light/dark setting. `"Light"` or `"Dark"` forces one.
- `<FluentTheme />` styles every control. Without a theme, controls are invisible!

### The ViewLocator: from ViewModel to View

A **data template** tells Avalonia "when you have to display an object of type X, build this UI for it".
The `ViewLocator` is one global data template that uses a **naming convention**:

```csharp
public class ViewLocator : IDataTemplate
{
    public Control? Build(object? param)
    {
        if (param is null) return null;
        var name = param.GetType().FullName!.Replace("ViewModel", "View", StringComparison.Ordinal);
        var type = Type.GetType(name);
        if (type != null) return (Control)Activator.CreateInstance(type)!;
        return new TextBlock { Text = "Not Found: " + name };
    }

    public bool Match(object? data) => data is ViewModelBase;
}
```

- `Match` says which objects it handles: anything deriving from `ViewModelBase`.
- `Build` takes the full type name, e.g. `QuestBoard.ViewModels.SettingsViewModel`, replaces
  *every* `ViewModel` with `View` → `QuestBoard.Views.SettingsView`, then creates that control by **reflection** (looking types up by their name
  while the program runs, instead of naming them in code the compiler can see).
- If it's not found, you see a `Not Found: …` text instead of a crash. That's the first thing to check
  when a page shows up blank.

Tiny example: put a ViewModel into the UI and the matching View appears.

```xml
<ContentControl Content="{Binding CurrentPage}" />
<!-- CurrentPage = new SettingsViewModel()  →  shows a SettingsView -->
```

You'll use this for navigation in **Navigation, DI & Services**. Note that `MainWindow` is **not** created by the
ViewLocator. `App` creates it directly, because a window can't be put inside other content.

:::pro title="Seniors often replace the reflection ViewLocator"
`Type.GetType` + `Activator.CreateInstance` uses reflection. **Trimming** (deleting unused code from a
published app to make it smaller) and **Native AOT** (compiling straight to machine code) can't see
that a type is only used by name, so they may remove it and break the app
(hence the `[RequiresUnreferencedCode]` attribute on the generated class). Bigger apps switch to an
explicit map (`{ typeof(SettingsViewModel), () => new SettingsView() }`) or to one `DataTemplate` per
ViewModel in XAML. It's checked at compile time and AOT-safe. The challenge below builds exactly that map.
:::

### ViewModels with CommunityToolkit.Mvvm

```csharp
public abstract class ViewModelBase : ObservableObject { }

public partial class MainViewModel : ViewModelBase
{
    [ObservableProperty]
    public partial string Greeting { get; set; } = "Welcome to Avalonia!";
}
```

- `ObservableObject` implements `INotifyPropertyChanged`, the .NET interface with one event,
  `PropertyChanged`, that bindings listen to. When a property raises it, the UI re-reads that property.
- `[ObservableProperty]` is an **attribute** read by a **source generator**: a compiler plug-in that
  writes extra C# during the build. Here it writes the property body: compare old and new value, store,
  raise `PropertyChanged("Greeting")`. You declare a `partial` property; the generator fills it in.

What the generator writes is roughly this (you never type it):

```csharp
public partial string Greeting
{
    get => field;
    set
    {
        if (EqualityComparer<string>.Default.Equals(field, value)) return; // no change → no event
        OnPropertyChanging(nameof(Greeting));
        field = value;
        OnPropertyChanged(nameof(Greeting));   // tells every binding "re-read Greeting"
    }
}
```

:::info title="Partial properties vs. fields"
With C# 14 / .NET 10 the toolkit annotates **partial properties** (`public partial string X { get; set; }`).
Older code annotates a **private field** instead (`[ObservableProperty] private string _greeting;`) and
the generator creates a `Greeting` property from it. Both work. You'll see the field style in lots of
existing projects.
:::

### Views and compiled bindings

```xml
<Window ...
        xmlns:vm="using:QuestBoard.ViewModels"
        x:Class="QuestBoard.Views.MainWindow"
        x:DataType="vm:MainViewModel"
        Title="QuestBoard">
    <Design.DataContext>
        <vm:MainViewModel />
    </Design.DataContext>

    <TextBox Text="{Binding Greeting}" />
</Window>
```

- `x:DataType="vm:MainViewModel"` turns on **compiled bindings**: the XAML compiler checks at *build*
  time that `MainViewModel` really has a `Greeting` property. A typo becomes a build error
  (`AVLN2000: Unable to resolve property or method of name …`), not a
  silently empty text box at runtime. It's also faster, because there's no reflection.
- `<Design.DataContext>` only feeds the **IDE previewer** with sample data. At runtime the real
  `DataContext` comes from `App.axaml.cs`.
- `MainWindow.axaml.cs` (the code-behind) just calls `InitializeComponent()`. In MVVM you keep it
  nearly empty.

:::quiz id=dsk-03-q4 xp=10
In `MainWindow.axaml` (with `x:DataType="vm:MainViewModel"`) you write `{Binding Greting}`, a typo.
What happens?
- [ ] The app runs and the text box is just empty
- [x] The build fails with an error saying the property can't be found
- [ ] The app crashes when the window opens
- [ ] Avalonia guesses the closest property name
> `x:DataType` makes bindings **compiled**: the XAML compiler resolves `Greting` against
> `MainViewModel` during the build and reports an error. Without `x:DataType` (reflection bindings)
> you'd get the silent empty box plus a warning in the log, the classic WPF debugging pain.
:::

:::quiz id=dsk-03-q5 xp=10
The ViewLocator receives an instance of `QuestBoard.ViewModels.QuestDetailsViewModel`. Which
type does it try to create?
- [ ] `QuestBoard.ViewModels.QuestDetailsView`
- [x] `QuestBoard.Views.QuestDetailsView`
- [ ] `QuestBoard.Views.QuestDetailsViewModel`
- [ ] `QuestBoard.Views.MainWindow`
> `Replace("ViewModel", "View")` replaces **every** occurrence: the namespace segment `ViewModels`
> becomes `Views`, and the class suffix `ViewModel` becomes `View`. If that class doesn't exist you see
> `Not Found: QuestBoard.Views.QuestDetailsView` on screen.
:::

:::quiz id=dsk-03-q6 xp=10
What does `[ObservableProperty]` actually do?
- [ ] It makes the property thread-safe
- [ ] It saves the property to disk when it changes
- [x] A source generator writes the property's setter so it raises `PropertyChanged` when the value changes
- [ ] It tells Avalonia to poll the property every frame
> It's a compile-time code generator, not runtime magic. The generated setter compares, stores, and raises
> `PropertyChanged`. Bindings subscribe to that event. Nothing polls. If the value is unchanged, no event
> is raised.
:::

Here's the core idea of change notification, in TypeScript so you can run it right here.

:::challenge id=dsk-03-c1 lang=ts xp=30
title: A tiny ObservableObject
Implement the heart of `ObservableObject`. `onPropertyChanged(handler)` registers a listener and returns
a function that unsubscribes it. `setProperty(name, value)` stores the value and calls every listener with
the property name, but **only if the value actually changed** (`===`), and returns `true` if it changed,
`false` otherwise. `get(name)` returns the stored value. Then `QuestViewModel` uses it for a `title`
property (getter + setter), which is exactly what `[ObservableProperty]` generates in C#.

hint: Keep listeners in an array and values in a `Map<string, unknown>`.
hint: In `setProperty`, compare with `this.values.get(name) === value` first and `return false` early.
hint: Unsubscribe with `this.listeners = this.listeners.filter(h => h !== handler)`.

```ts starter
type Handler = (propertyName: string) => void

export class ObservableObject {
  private listeners: Handler[] = []
  private values = new Map<string, unknown>()

  onPropertyChanged(handler: Handler): () => void {
    return () => {}
  }

  get<T>(name: string): T {
    return this.values.get(name) as T
  }

  setProperty(name: string, value: unknown): boolean {
    this.values.set(name, value)
    return true
  }
}

export class QuestViewModel extends ObservableObject {
  constructor() {
    super()
    this.setProperty('title', '')
  }
  get title(): string { return this.get<string>('title') }
  set title(v: string) { this.setProperty('title', v) }
}
```

```ts solution
type Handler = (propertyName: string) => void

export class ObservableObject {
  private listeners: Handler[] = []
  private values = new Map<string, unknown>()

  onPropertyChanged(handler: Handler): () => void {
    this.listeners.push(handler)
    return () => { this.listeners = this.listeners.filter((h) => h !== handler) }
  }

  get<T>(name: string): T {
    return this.values.get(name) as T
  }

  setProperty(name: string, value: unknown): boolean {
    if (this.values.has(name) && this.values.get(name) === value) return false
    this.values.set(name, value)
    for (const h of [...this.listeners]) h(name)
    return true
  }
}

export class QuestViewModel extends ObservableObject {
  constructor() {
    super()
    this.setProperty('title', '')
  }
  get title(): string { return this.get<string>('title') }
  set title(v: string) { this.setProperty('title', v) }
}
```

```ts tests
test('setting a new value notifies with the property name', () => {
  const vm = new QuestViewModel()
  const seen: string[] = []
  vm.onPropertyChanged((n) => seen.push(n))
  vm.title = 'Slay the dragon'
  expect(vm.title).toBe('Slay the dragon')
  expect(seen).toEqual(['title'])
})
test('setting the same value again does not notify', () => {
  const vm = new QuestViewModel()
  const seen: string[] = []
  vm.title = 'A'
  vm.onPropertyChanged((n) => seen.push(n))
  vm.title = 'A'
  expect(seen).toEqual([])
})
test('setProperty reports whether it changed', () => {
  const o = new ObservableObject()
  expect(o.setProperty('xp', 10)).toBe(true)
  expect(o.setProperty('xp', 10)).toBe(false)
  expect(o.setProperty('xp', 20)).toBe(true)
  expect(o.get('xp')).toBe(20)
})
test('every listener is called', () => {
  const vm = new QuestViewModel()
  const a = fn(), b = fn()
  vm.onPropertyChanged(a)
  vm.onPropertyChanged(b)
  vm.title = 'X'
  expect(a).toHaveBeenCalledWith('title')
  expect(b).toHaveBeenCalledTimes(1)
})
test('unsubscribe stops notifications', () => {
  const vm = new QuestViewModel()
  const h = fn()
  const off = vm.onPropertyChanged(h)
  vm.title = 'one'
  off()
  vm.title = 'two'
  expect(h).toHaveBeenCalledTimes(1)
})
```
:::

## Running on Windows, macOS and Linux

The same `dotnet run` works on all three. What you need per OS:

| OS | Needs | Notes |
|---|---|---|
| Windows 10/11 | .NET 10 SDK | Nothing else. |
| macOS (Intel or Apple Silicon) | .NET 10 SDK | Run from Terminal. For a proper `.app` bundle you package later (covered later in this region). |
| Linux (X11 or Wayland via XWayland) | .NET 10 SDK, a desktop session | Most distros have the libraries already. On minimal installs add fontconfig and the X11 libs (e.g. `libx11-6 libice6 libsm6 libfontconfig1` on Debian/Ubuntu). |

:::warn title="Platform details change between releases"
Exact OS requirements (supported macOS versions, native Wayland support, needed Linux packages) move
with each Avalonia release. Check the "Platform support" page at https://docs.avaloniaui.net before you
promise a customer a specific OS.
:::

To get a self-contained build for another OS without installing .NET there, you **publish** with a
runtime identifier, for example:

```bash
dotnet publish -c Release -r linux-x64   --self-contained
dotnet publish -c Release -r win-x64     --self-contained
dotnet publish -c Release -r osx-arm64   --self-contained
```

You can produce the Linux and Windows builds from any OS. Signing and notarising a macOS app needs a Mac.

:::quiz id=dsk-03-q7 xp=10
Your colleague on Linux runs QuestBoard and it works. What do you need to change so it runs on your
Windows laptop?
- [x] Nothing: `UsePlatformDetect()` picks the Windows back-end at runtime
- [ ] Replace `Avalonia.Desktop` with `Avalonia.Win32`
- [ ] Rewrite the XAML, because Windows uses WPF XAML
- [ ] Switch to `ISingleViewApplicationLifetime`
> `Avalonia.Desktop` brings the Win32, macOS and X11 back-ends, and `UsePlatformDetect()` chooses one
> at startup. The XAML is the same on every OS. `ISingleViewApplicationLifetime` is for mobile and browser,
> not for desktop windows.
:::

## Your tools: IDEs, hot reload, Developer Tools

### IDE support

| IDE | Avalonia support |
|---|---|
| **JetBrains Rider** | Built-in Avalonia support: XAML completion, live previewer, binding inspections. The most complete option, and free for non-commercial use. |
| **Visual Studio 2022/2026** (Windows) | Install the **Avalonia for Visual Studio** extension for the previewer and XAML completion. |
| **VS Code** | Install the official **Avalonia** extension (XAML completion + previewer) together with **C# Dev Kit**. Works on Linux and macOS too. |

The **previewer** renders your `.axaml` file next to the editor, using the `Design.DataContext` sample
data. It needs the project to have been **built once**, because it loads your compiled assembly.
If the previewer shows nothing, build first.

### Hot reload

**Hot reload** means changing code while the app runs and seeing the change without restarting.

```bash
dotnet watch
```

`dotnet watch` rebuilds when files change. Edits inside C# method bodies are often applied **live**
(.NET Hot Reload). Changes it can't apply live (new properties, many XAML edits) trigger an automatic
**rebuild and restart**. When it asks, answer `a` ("always") to allow that. For XAML-only
iteration most people lean on the **IDE previewer**, and some teams add the community package
*HotAvalonia* for live XAML reloading.

:::tip title="Fast loop"
Keep `dotnet watch` running in a terminal and the previewer open next to the XAML. Most layout work
then never needs a manual restart.
:::

### Developer Tools (F12)

Avalonia's **Developer Tools** are like the browser's F12 tools, but for your app: a live tree of every
control, its properties, applied styles, layout sizes, and binding errors. They run as a **separate app**
that your app connects to:

```bash
dotnet tool install --global AvaloniaUI.DeveloperTools   # once per machine
```

Start the tool (its command is `avdt`), run QuestBoard in **Debug**, focus the QuestBoard window and press
**F12**. The template already did the app-side setup: the `AvaloniaUI.DiagnosticsSupport` package plus
`.WithDeveloperTools()` inside `#if DEBUG` in `Program.cs`.

:::info title="On an Avalonia 11 project?"
Older projects use the package `Avalonia.Diagnostics` and call `this.AttachDevTools();` in
`MainWindow`'s constructor (inside `#if DEBUG`). F12 then opens an in-app DevTools window instead of a
separate tool. Same idea, older UI.
:::

:::quiz id=dsk-03-q8 xp=10
A button in your app is mysteriously 2 px wider than its neighbour. Which is the fastest way to find out why?
- [ ] Add `Console.WriteLine` to the code-behind and print `Bounds`
- [x] Press F12 with Developer Tools running, select the button, and inspect its margin, padding, styles and layout size
- [ ] Rebuild in Release mode
- [ ] Delete the Fluent theme
> The visual tree inspector shows the computed layout and **which style set which value**, the same
> way browser devtools do for CSS. Developer Tools only connect in **Debug** builds, so Release mode would
> remove the tool you need.
:::

## Commands: making a button do something

A **command** is an object a button can invoke. In .NET it's the `ICommand` interface:

```csharp
public interface ICommand
{
    bool CanExecute(object? parameter);     // may it run right now? (button enabled?)
    void Execute(object? parameter);        // do the work
    event EventHandler? CanExecuteChanged;  // "ask me CanExecute again"
}
```

Why not just an `onClick` handler in the code-behind? Because a command lives in the **ViewModel**:
you can unit-test it without a window, and the button **disables itself** whenever `CanExecute` is
false. No manual `IsEnabled` juggling.

The toolkit's `[RelayCommand]` writes the `ICommand` property for you:

```csharp
[RelayCommand(CanExecute = nameof(CanAddQuest))]
private void AddQuest() { /* ... */ }            // generator creates: public IRelayCommand AddQuestCommand

private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewQuestTitle);
```

```xml
<Button Content="Add quest" Command="{Binding AddQuestCommand}" />
```

Notice the naming: method `AddQuest` → property `AddQuestCommand`. The button only asks `CanExecute`
again when `CanExecuteChanged` fires, so the text property must announce it:

```csharp
[ObservableProperty]
[NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]   // when NewQuestTitle changes → re-check CanAddQuest
public partial string NewQuestTitle { get; set; } = "";
```

Forget that attribute and the button stays disabled forever after you type, the most common
beginner bug with commands.

A list that the UI should follow uses `ObservableCollection<T>`. It raises `CollectionChanged` when
items are added or removed, so the `ListBox` updates. A plain `List<T>` would never tell the UI.

:::challenge id=dsk-03-c2 lang=ts xp=40
title: A RelayCommand with CanExecute
Implement `RelayCommand` like the toolkit's. Its constructor takes `execute` and an optional `canExecute`
(missing means "always allowed"). `canExecute()` returns the predicate's result. `execute()` runs the action
**only if** `canExecute()` is true. `onCanExecuteChanged(handler)` registers a listener, and
`notifyCanExecuteChanged()` calls all listeners.

Then finish `AddQuestViewModel`: `quests` starts empty; `newQuestTitle` has a setter that stores the value
and calls `addQuestCommand.notifyCanExecuteChanged()` (that's `[NotifyCanExecuteChangedFor]`); the command
adds the **trimmed** title to `quests`, then sets `newQuestTitle` back to `''`; it can only execute when
the trimmed title isn't empty.

hint: Store `execute` and `canExecute` in normal fields assigned in the constructor (no parameter properties).
hint: `canExecute(): boolean { return this.canExec ? this.canExec() : true }`
hint: In the ViewModel's setter: `this._title = v; this.addQuestCommand.notifyCanExecuteChanged()`

```ts starter
export class RelayCommand {
  constructor(execute: () => void, canExecute?: () => boolean) {}
  canExecute(): boolean { return true }
  execute(): void {}
  onCanExecuteChanged(handler: () => void): void {}
  notifyCanExecuteChanged(): void {}
}

export class AddQuestViewModel {
  quests: string[] = []
  private _title = ''
  readonly addQuestCommand = new RelayCommand(() => {}, () => true)

  get newQuestTitle(): string { return this._title }
  set newQuestTitle(v: string) { this._title = v }
}
```

```ts solution
export class RelayCommand {
  private exec: () => void
  private canExec?: () => boolean
  private handlers: (() => void)[] = []

  constructor(execute: () => void, canExecute?: () => boolean) {
    this.exec = execute
    this.canExec = canExecute
  }
  canExecute(): boolean { return this.canExec ? this.canExec() : true }
  execute(): void { if (this.canExecute()) this.exec() }
  onCanExecuteChanged(handler: () => void): void { this.handlers.push(handler) }
  notifyCanExecuteChanged(): void { for (const h of this.handlers) h() }
}

export class AddQuestViewModel {
  quests: string[] = []
  private _title = ''
  readonly addQuestCommand = new RelayCommand(
    () => {
      this.quests.push(this._title.trim())
      this.newQuestTitle = ''
    },
    () => this._title.trim().length > 0,
  )

  get newQuestTitle(): string { return this._title }
  set newQuestTitle(v: string) {
    this._title = v
    this.addQuestCommand.notifyCanExecuteChanged()
  }
}
```

```ts tests
test('a command without canExecute is always allowed', () => {
  const run = fn()
  const cmd = new RelayCommand(run)
  expect(cmd.canExecute()).toBe(true)
  cmd.execute()
  expect(run).toHaveBeenCalledTimes(1)
})
test('execute does nothing when canExecute is false', () => {
  const run = fn()
  const cmd = new RelayCommand(run, () => false)
  cmd.execute()
  expect(run).not.toHaveBeenCalled()
})
test('notifyCanExecuteChanged calls listeners', () => {
  const cmd = new RelayCommand(() => {})
  const h = fn()
  cmd.onCanExecuteChanged(h)
  cmd.notifyCanExecuteChanged()
  expect(h).toHaveBeenCalledTimes(1)
})
test('Add quest is disabled for an empty or blank title', () => {
  const vm = new AddQuestViewModel()
  expect(vm.addQuestCommand.canExecute()).toBe(false)
  vm.newQuestTitle = '   '
  expect(vm.addQuestCommand.canExecute()).toBe(false)
})
test('typing a title raises CanExecuteChanged', () => {
  const vm = new AddQuestViewModel()
  const h = fn()
  vm.addQuestCommand.onCanExecuteChanged(h)
  vm.newQuestTitle = 'Learn XAML'
  expect(h).toHaveBeenCalled()
  expect(vm.addQuestCommand.canExecute()).toBe(true)
})
test('executing adds the trimmed title and clears the box', () => {
  const vm = new AddQuestViewModel()
  vm.newQuestTitle = '  Learn bindings '
  vm.addQuestCommand.execute()
  expect(vm.quests).toEqual(['Learn bindings'])
  expect(vm.newQuestTitle).toBe('')
  expect(vm.addQuestCommand.canExecute()).toBe(false)
})
```
:::

The next challenge is the ViewLocator, done the AOT-friendly way the `:::pro` box described.

:::challenge id=dsk-03-c3 lang=ts xp=30
title: An explicit ViewLocator
Write `viewNameFor(fullName)` that applies the template's convention: replace **every** `ViewModel`
with `View` (`'QuestBoard.ViewModels.MainViewModel'` → `'QuestBoard.Views.MainView'`).

Then write `createLocator(registry)`. `registry` maps a **view name** to a factory function that returns a
view (here just a string). The locator has `match(vm)` (true only if `vm.isViewModel === true`, like
`data is ViewModelBase`) and `build(vm)`: return `null` for `null`; otherwise look up
`viewNameFor(vm.typeName)` in the registry and call the factory, or return `'Not Found: ' + name`.

hint: `fullName.split('ViewModel').join('View')` or `fullName.replaceAll('ViewModel', 'View')`.
hint: `const factory = registry[name]; return factory ? factory() : 'Not Found: ' + name`

```ts starter
type VM = { typeName: string; isViewModel: boolean }

export function viewNameFor(fullName: string): string {
  return fullName.replace('ViewModel', 'View')
}

export function createLocator(registry: Record<string, () => string>) {
  return {
    match(vm: unknown): boolean { return true },
    build(vm: VM | null): string | null { return null },
  }
}
```

```ts solution
type VM = { typeName: string; isViewModel: boolean }

export function viewNameFor(fullName: string): string {
  return fullName.split('ViewModel').join('View')
}

export function createLocator(registry: Record<string, () => string>) {
  return {
    match(vm: unknown): boolean {
      return typeof vm === 'object' && vm !== null && (vm as VM).isViewModel === true
    },
    build(vm: VM | null): string | null {
      if (vm === null) return null
      const name = viewNameFor(vm.typeName)
      const factory = registry[name]
      return factory ? factory() : 'Not Found: ' + name
    },
  }
}
```

```ts tests
test('replaces namespace and suffix', () => {
  expect(viewNameFor('QuestBoard.ViewModels.MainViewModel')).toBe('QuestBoard.Views.MainView')
  expect(viewNameFor('QuestBoard.ViewModels.QuestDetailsViewModel')).toBe('QuestBoard.Views.QuestDetailsView')
})
test('builds the registered view', () => {
  const loc = createLocator({ 'QuestBoard.Views.SettingsView': () => 'SettingsView instance' })
  expect(loc.build({ typeName: 'QuestBoard.ViewModels.SettingsViewModel', isViewModel: true })).toBe('SettingsView instance')
})
test('unknown view shows Not Found', () => {
  const loc = createLocator({})
  expect(loc.build({ typeName: 'QuestBoard.ViewModels.AboutViewModel', isViewModel: true }))
    .toBe('Not Found: QuestBoard.Views.AboutView')
})
test('null builds null', () => {
  expect(createLocator({}).build(null)).toBeNull()
})
test('match only accepts view models', () => {
  const loc = createLocator({})
  expect(loc.match({ typeName: 'X', isViewModel: true })).toBe(true)
  expect(loc.match({ typeName: 'QuestBoard.Models.Quest', isViewModel: false })).toBe(false)
  expect(loc.match('hello')).toBe(false)
  expect(loc.match(null)).toBe(false)
})
```
:::

## Lab: QuestBoard's first feature

:::lab id=dsk-03-lab1 xp=100
title: Create QuestBoard and add quests with a button
You'll create the app, replace the greeting with a quest list, add a text box + **Add quest** button
driven by a command, and prove it works with xUnit tests, all without a single line of code-behind.

**Prerequisites:** .NET 10 SDK (`dotnet --version` prints `10.0.x`), and a terminal on Windows,
macOS or Linux. (Verified with .NET SDK 10.0.4xx, Avalonia.Templates 12.1.5, CommunityToolkit.Mvvm 8.4.2
and the stock `xunit` template: builds with 0 warnings, 4 tests pass.)

**1. Install the templates and create the app**

```bash
dotnet new install Avalonia.Templates
mkdir questboard-lab && cd questboard-lab
dotnet new avalonia.mvvm -o QuestBoard
dotnet run --project QuestBoard
```

Expected: a window titled **QuestBoard** with a text box *Welcome to Avalonia!*. Close it.

**2. Add a model.** Create the folder (`mkdir QuestBoard/Models`, the template only declares it) and
the file `QuestBoard/Models/Quest.cs`:

```csharp
namespace QuestBoard.Models;

public record Quest(string Title, int Xp);
```

A `record` is a class made for data: you get a constructor, read-only properties `Title` and `Xp`,
value equality and a readable `ToString()` from one line.

**3. Replace `QuestBoard/ViewModels/MainViewModel.cs`** completely:

```csharp
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QuestBoard.Models;

namespace QuestBoard.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    // The list the window shows. ObservableCollection tells the UI when items are added/removed.
    public ObservableCollection<Quest> Quests { get; } =
    [
        new Quest("Install the Avalonia templates", 10),
    ];

    // Bound to the TextBox. When it changes, re-check whether "Add quest" may run.
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]
    public partial string NewQuestTitle { get; set; } = "";

    // The source generator turns this method into a public AddQuestCommand property.
    [RelayCommand(CanExecute = nameof(CanAddQuest))]
    private void AddQuest()
    {
        Quests.Add(new Quest(NewQuestTitle.Trim(), 10));
        NewQuestTitle = "";
    }

    private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewQuestTitle);
}
```

The `[ ... ]` after `=` is a C# **collection expression**: it builds the collection with one quest in it.

**4. Replace `QuestBoard/Views/MainWindow.axaml`** completely:

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.ViewModels"
        xmlns:m="using:QuestBoard.Models"
        xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
        xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
        mc:Ignorable="d" d:DesignWidth="480" d:DesignHeight="400"
        x:Class="QuestBoard.Views.MainWindow"
        x:DataType="vm:MainViewModel"
        Icon="/Assets/avalonia-logo.ico"
        Width="480" Height="400"
        Title="QuestBoard">

    <Design.DataContext>
        <vm:MainViewModel />
    </Design.DataContext>

    <DockPanel Margin="16">
        <TextBlock DockPanel.Dock="Top" Text="QuestBoard" FontSize="24" FontWeight="Bold" Margin="0,0,0,12" />

        <StackPanel DockPanel.Dock="Top" Orientation="Horizontal" Spacing="8" Margin="0,0,0,12">
            <TextBox Text="{Binding NewQuestTitle}" PlaceholderText="New quest title" Width="280" />
            <Button Content="Add quest" Command="{Binding AddQuestCommand}" IsDefault="True" />
        </StackPanel>

        <TextBlock DockPanel.Dock="Bottom" Text="{Binding Quests.Count, StringFormat='{}{0} quest(s)'}" Margin="0,12,0,0" />

        <ListBox ItemsSource="{Binding Quests}">
            <ListBox.ItemTemplate>
                <DataTemplate x:DataType="m:Quest">
                    <TextBlock Text="{Binding Title}" />
                </DataTemplate>
            </ListBox.ItemTemplate>
        </ListBox>
    </DockPanel>
</Window>
```

What's new here:

- `DockPanel` stacks children against its edges (`DockPanel.Dock="Top"`/`"Bottom"`). The **last**
  child (the `ListBox`) fills the remaining space.
- `IsDefault="True"` makes **Enter** press the button.
- `StringFormat='{}{0} quest(s)'`: the `{}` escapes the braces so XAML doesn't read `{0}` as markup.
- The `DataTemplate` gets its own `x:DataType="m:Quest"`, because inside the list each item is a
  `Quest`, not the ViewModel. Compiled bindings need to know that.

:::info
On an **Avalonia 11** project, write `Watermark="New quest title"` instead of `PlaceholderText`. Avalonia 12
renamed it, and the old name produces an obsolete warning.
:::

**5. Build and run**

```bash
dotnet build QuestBoard
dotnet run --project QuestBoard
```

Expected build output ends with `0 Warning(s)` and `0 Error(s)`. In the window: the button is
**disabled** while the box is empty; type `Learn bindings`, press Enter, and the quest appears, the box
clears, and the footer says `2 quest(s)`.

**6. Prove it with tests.** The ViewModel knows nothing about windows, so plain xUnit can test it:

```bash
dotnet new xunit -o QuestBoard.Tests
dotnet add QuestBoard.Tests reference QuestBoard/QuestBoard.csproj
```

Delete `QuestBoard.Tests/UnitTest1.cs` and create `QuestBoard.Tests/MainViewModelTests.cs`:

```csharp
using QuestBoard.ViewModels;
using Xunit;

namespace QuestBoard.Tests;

public class MainViewModelTests
{
    [Fact]
    public void Starts_with_one_quest()
    {
        var vm = new MainViewModel();
        Assert.Single(vm.Quests);
    }

    [Fact]
    public void Cannot_add_an_empty_title()
    {
        var vm = new MainViewModel { NewQuestTitle = "   " };
        Assert.False(vm.AddQuestCommand.CanExecute(null));
    }

    [Fact]
    public void Adding_a_quest_appends_it_and_clears_the_box()
    {
        var vm = new MainViewModel { NewQuestTitle = "  Learn bindings " };
        Assert.True(vm.AddQuestCommand.CanExecute(null));

        vm.AddQuestCommand.Execute(null);

        Assert.Equal(2, vm.Quests.Count);
        Assert.Equal("Learn bindings", vm.Quests[1].Title);
        Assert.Equal("", vm.NewQuestTitle);
        Assert.False(vm.AddQuestCommand.CanExecute(null));
    }

    [Fact]
    public void Typing_a_title_raises_CanExecuteChanged()
    {
        var vm = new MainViewModel();
        var raised = 0;
        vm.AddQuestCommand.CanExecuteChanged += (_, _) => raised++;

        vm.NewQuestTitle = "Slay the build error";

        Assert.True(raised > 0);
    }
}
```

```bash
dotnet test QuestBoard.Tests
```

Expected (last line; a `Duration` follows, and the text is translated if your OS isn't in English):

```text
Passed!  - Failed:     0, Passed:     4, Skipped:     0, Total:     4
```

**7. Try the tools.** Run `dotnet watch --project QuestBoard`, change the starting quest's text in
`MainViewModel.cs`, save, and watch the app rebuild/restart. Then install the Developer Tools
(`dotnet tool install --global AvaloniaUI.DeveloperTools`), start `avdt`, focus QuestBoard and press
**F12**. Find the `Button` in the visual tree and look at its `IsEffectivelyEnabled` while you type.

:::warn title="Breaking it on purpose teaches the most"
Remove `[NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]` and run again: the button stays disabled
after you type, and test 4 fails. Then rename `{Binding NewQuestTitle}` to `{Binding NewQuestTitel}` and
build: compiled bindings stop the build with `error AVLN2000: Unable to resolve property or method of
name 'NewQuestTitel'`. Put both back afterwards.
:::

- [ ] `dotnet new avalonia.mvvm` created QuestBoard and `dotnet run` opened the window
- [ ] The **Add quest** button is disabled for an empty/blank title and adds a trimmed quest on click or Enter
- [ ] The footer count updates (`2 quest(s)` after one add) and the text box clears
- [ ] `dotnet test QuestBoard.Tests` reports 4 passed, 0 failed
- [ ] You saw the compiled-binding build error for a misspelled property
- [ ] You ran the app with `dotnet watch` and opened Developer Tools with F12
:::

:::pro title="Keep the code-behind empty"
Everything in the lab (state, the rule "no blank titles", the add action) lives in the ViewModel, so
four tests ran in milliseconds without a window. Teams enforce this in review: code-behind is for
purely visual things (focus, animations), never for business rules.
:::

## Flashcards

:::cards id=dsk-03-cards1 xp=15 title="First Avalonia app"
Q: How do you install Avalonia's project templates?
A: `dotnet new install Avalonia.Templates` (run again to update).
Q: Which template gives you Views, ViewModels and a ViewLocator?
A: `dotnet new avalonia.mvvm`
Q: What does `UsePlatformDetect()` do?
A: Picks the Windows, macOS or Linux back-end at runtime, so one codebase runs on all of them.
Q: What is the classic desktop lifetime?
A: `IClassicDesktopStyleApplicationLifetime`: windows + `MainWindow`; by default the app exits when the last window closes.
Q: Where do you create the main window?
A: `App.OnFrameworkInitializationCompleted`, setting `desktop.MainWindow` and its `DataContext`.
Q: What does the ViewLocator do?
A: Maps a ViewModel to its View by name (`…ViewModels.XViewModel` → `…Views.XView`) and creates it.
Q: What does `x:DataType` enable?
A: Compiled bindings: binding paths are checked at build time and run without reflection.
Q: What does `[ObservableProperty]` generate?
A: A property whose setter raises `PropertyChanged` when the value really changes.
Q: What does `[RelayCommand]` on `AddQuest()` generate?
A: A public `AddQuestCommand` (`IRelayCommand`); `CanExecute = nameof(…)` wires the enable rule.
Q: Why `[NotifyCanExecuteChangedFor]`?
A: So the command's `CanExecuteChanged` fires when the property changes; otherwise the button never re-enables.
Q: How do you open Avalonia Developer Tools?
A: Debug build + DiagnosticsSupport package, run the DeveloperTools app (`avdt`), press F12 in your app.
Q: Why `ObservableCollection<T>` instead of `List<T>`?
A: It raises `CollectionChanged`, so bound lists update when items are added or removed.
:::

## Recap

- **Avalonia** draws its own UI with Skia, so one XAML + C# codebase looks and behaves the same on
  Windows, macOS and Linux (and mobile/browser).
- `dotnet new install Avalonia.Templates` once, then `dotnet new avalonia.mvvm -o QuestBoard`.
- Startup chain: `Program.Main` → `AppBuilder` (`UsePlatformDetect`) → **classic desktop lifetime** →
  `App.Initialize` → `OnFrameworkInitializationCompleted` creates `MainWindow` with its `DataContext`.
- `App.axaml` holds the theme (`FluentTheme`) and the **ViewLocator**, which maps `XViewModel` → `XView` by name.
- **CommunityToolkit.Mvvm** source generators write `PropertyChanged` plumbing (`[ObservableProperty]`)
  and commands (`[RelayCommand]`, with `CanExecute` + `[NotifyCanExecuteChangedFor]`).
- `x:DataType` = **compiled bindings**: typos fail the build. Put it on windows *and* data templates.
- Tools: Rider / VS extension / VS Code extension with previewer, `dotnet watch` for hot reload, and
  **Developer Tools (F12)** for inspecting the live visual tree.
- Keep logic in ViewModels so plain xUnit tests cover it without a window.
