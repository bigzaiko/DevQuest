---
id: dsk-09
title: .NET MAUI Fundamentals
level: intermediate
minutes: 75
xp: 150
summary: One C# project for Android, iOS, macOS and Windows: the MAUI single project, MauiProgram and DI, Shell routes with query parameters, and running QuestBoard on a phone emulator.
---

## Why MAUI exists

Avalonia draws every pixel itself, so a button looks the same on Windows, macOS and Linux. That is
great for desktop tools. Phones are different: users expect a **native** Android date picker, the
iOS swipe-back gesture and the system keyboard that matches their phone. Your company may also
already have C# developers, a C# backend and shared validation code, and they don't want to rewrite
it all in Kotlin and Swift.

**.NET MAUI** (Multi-platform App UI) is Microsoft's answer: you write **one C# project**, and MAUI
turns each `Button` into the platform's real button. That means `android.widget.Button` on Android,
`UIButton` on iOS and Mac Catalyst, and a WinUI `Button` on Windows. It replaced **Xamarin.Forms**
(support ended in May 2024), so if you inherit an older mobile app at work it is probably being
migrated to MAUI right now.

Three names you'll see a lot:

- **Mac Catalyst**: Apple's technology for running an iPad-style (UIKit) app as a normal macOS
  desktop app. MAUI's "macOS" target is a Mac Catalyst app.
- **WinUI 3**: Microsoft's current native UI framework for Windows desktop apps. MAUI's Windows
  target is a WinUI 3 app.
- **Skia**: the open-source 2D drawing library (also used by Chrome and Android) that Avalonia uses
  to paint its controls.

| | Avalonia (earlier in this region) | .NET MAUI 10 |
|---|---|---|
| Rendering | Draws everything itself (Skia) | Wraps **native** platform controls |
| Targets | Windows, macOS, Linux, (browser, mobile) | Android, iOS, Mac Catalyst, Windows |
| Linux desktop | Yes | **No** |
| Looks | Identical everywhere | Native look per platform |
| Typical job | Internal tools, cross-platform desktop | Field-service apps, companion apps, B2B mobile |

:::warn title="Linux cannot build MAUI apps"
There is **no Linux target** in MAUI, and the `maui` workload cannot build or run apps on a Linux
machine. Building for iOS or Mac Catalyst needs a **Mac** with Xcode. Building for Windows needs
**Windows**. Android builds on Windows and macOS. If you're on Linux, read this lesson and do the
quizzes and the challenge here; do the lab on a Windows or macOS machine (a borrowed laptop or a cloud
VM is fine). Everything in the lab was written for, and is to be verified on, Windows/macOS by you.
:::

## The single project

A **single project** means one `.csproj` that builds for several platforms at once. Older Xamarin
apps had one project per platform plus a shared one. MAUI uses **multi-targeting** instead: the
project lists several **target frameworks** (TFMs, the "which platform am I building for" labels), and
`dotnet build` compiles the same code once per TFM.

```xml
<!-- QuestBoard.Mobile.csproj (trimmed) -->
<PropertyGroup>
  <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net10.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ApplicationId>com.companyname.questboard.mobile</ApplicationId>
</PropertyGroup>
```

- `net10.0-android` is a **TFM**: .NET 10 plus the Android API bindings.
- `UseMaui` pulls in the MAUI framework; `SingleProject` turns on the "one project, many platforms" layout.
- `ApplicationId` is the store identity (reverse-DNS). Changing it later makes a *different* app in
  the stores, so pick it before your first release.

The folders a new project gives you:

```text
QuestBoard.Mobile/
  App.xaml / App.xaml.cs         ← application object: global resources, creates the first Window
  AppShell.xaml / .xaml.cs       ← the Shell: tabs, flyout, routes
  MainPage.xaml / .xaml.cs       ← a sample page (we replace it in the lab)
  MauiProgram.cs                 ← the builder: DI, fonts, logging (like Program.cs in ASP.NET Core)
  Platforms/
    Android/   MainActivity.cs, MainApplication.cs, AndroidManifest.xml
    iOS/       AppDelegate.cs, Program.cs, Info.plist
    MacCatalyst/  AppDelegate.cs, Program.cs, Info.plist
    Windows/   App.xaml, Package.appxmanifest
  Resources/
    AppIcon/  Fonts/  Images/  Splash/  Raw/  Styles/
```

**`Platforms/`** holds the small piece of native start-up code each OS needs. On Android an
`Activity` starts the app, and on iOS an `AppDelegate` does. Files in `Platforms/Android` are compiled
**only** for the Android TFM, so you can call Android APIs there without `#if`. Permissions also live
here: camera access goes into `AndroidManifest.xml` and `Info.plist`.

**`Resources/`** is shared. You add **one** SVG to `Resources/Images`, and the build generates every
PNG size Android and iOS need. `Resources/AppIcon` and `Resources/Splash` work the same way. That
saves you from hand-making 20 icon files.

:::quiz id=dsk-09-q1 xp=10
You add `Platforms/Android/VibrationHelper.cs`, which calls `Android.OS.Vibrator`. What happens when
you build for `net10.0-ios`?
- [ ] The build fails because iOS has no `Android.OS` namespace
- [x] The file is not compiled for iOS at all; it's included only in the Android build
- [ ] MAUI translates the call to the iOS haptics API automatically
- [ ] It compiles, but throws `PlatformNotSupportedException` at runtime
> The single project includes files under `Platforms/<Name>/` only for the matching target
> framework. That's why native API calls belong there (or behind `#if ANDROID`). MAUI never
> translates arbitrary native APIs for you. It only offers cross-platform wrappers such as
> `HapticFeedback` and `Vibration` in `Microsoft.Maui.Devices`.
:::

## MauiProgram: the builder and dependency injection

Every MAUI app starts from `MauiProgram.CreateMauiApp()`. Each platform's native entry point
(`MainApplication` on Android, `AppDelegate` on iOS, `App` on Windows) calls it. It's the same
**host builder** pattern you know from ASP.NET Core's `Program.cs`. You configure services, fonts and
logging, then call `Build()`.

```csharp
public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()                          // which Application class to start
            .ConfigureFonts(f => f.AddFont("OpenSans-Regular.ttf", "OpenSansRegular"));

        builder.Services.AddSingleton<QuestStore>();      // one for the whole app
        builder.Services.AddTransient<QuestListViewModel>(); // new one each time it's asked for
        builder.Services.AddTransient<QuestListPage>();

        return builder.Build();
    }
}
```

**Dependency injection (DI)** means a class lists what it needs in its constructor, and a container
(the `builder.Services` collection above, turned into a *service provider* by `Build()`) creates
those things for it. When Shell needs a page, it asks the service provider for the page type. So a
page can simply ask for its view model:

```csharp
public partial class QuestListPage : ContentPage
{
    public QuestListPage(QuestListViewModel vm)   // DI hands us the view model…
    {
        InitializeComponent();
        BindingContext = vm;                      // …and bindings in XAML read from it
    }
}
```

How exactly does Shell create the page? It calls `ActivatorUtilities.GetServiceOrCreateInstance`:
if the page type is registered, the container builds it with the lifetime you chose. If it isn't
registered, Shell still calls the page's constructor itself, but **every constructor parameter must
come from the container**. So the hard rule is: everything a page *asks for* must be registered.
Teams register the pages too, so that each page's lifetime is written down in one place instead of
being an accident.

The lifetimes are the ones you know from the backend, but they *feel* different in an app:

| Lifetime | In ASP.NET Core | In a MAUI app |
|---|---|---|
| `AddSingleton` | One per server process | One per app run: caches, stores, an `HttpClient` wrapper |
| `AddTransient` | New on every resolve | New on every resolve: pages and their view models |
| `AddScoped` | One per HTTP request | Rarely useful: there's no request, and Shell does not create scopes per page |

:::quiz id=dsk-09-q2 xp=10
`QuestDetailPage` takes a `QuestDetailViewModel` in its constructor. In `MauiProgram` you registered
**the page**, but forgot to register **the view model**. Shell navigates to the page via a
registered route. What do you get?
- [ ] It works: the container creates any class it is asked for, registered or not
- [x] A runtime `InvalidOperationException` ("Unable to resolve service for type `QuestDetailViewModel`…") on the first navigation
- [ ] A compile error in `MauiProgram.cs`
- [ ] The page opens with `BindingContext` set to `null`
> The container can only hand out what is registered. To build the page it needs a
> `QuestDetailViewModel`, finds none, and throws `InvalidOperationException` while navigating. The
> compiler can't check registrations, so DI mistakes in MAUI show up at **runtime**, on the first
> navigation to that page. (The reverse mistake, a registered view model but an unregistered page,
> actually works: Shell falls back to calling the page constructor and fills its parameters from the
> container.) That's why teams register every page and view model and open each page once in a test.
:::

## XAML in MAUI vs Avalonia and WPF

The XAML *language* is the same: elements are objects, attributes are properties, `{Binding}` and
`x:Name` work as you expect. The **vocabulary** is different, and that's what trips people up on
day one.

| Concept | WPF | Avalonia | MAUI |
|---|---|---|---|
| Default namespace | `…/winfx/2006/xaml/presentation` | `https://github.com/avaloniaui` | `http://schemas.microsoft.com/dotnet/2021/maui` |
| Top-level screen | `Window` / `UserControl` | `Window` / `UserControl` | `ContentPage` (inside a Shell) |
| Read-only text | `TextBlock` | `TextBlock` | `Label` |
| Single-line input | `TextBox` | `TextBox` | `Entry` (`Editor` for multi-line) |
| Vertical stack | `StackPanel` | `StackPanel` | `VerticalStackLayout` |
| Item list | `ListBox` / `ItemsControl` | `ListBox` / `ItemsControl` | `CollectionView` |
| Alignment | `HorizontalAlignment` | `HorizontalAlignment` | `HorizontalOptions` |
| Hide an element | `Visibility="Collapsed"` | `IsVisible="False"` | `IsVisible="False"` |
| Grid shorthand | No (verbose `<ColumnDefinition>`s) | `ColumnDefinitions="*,Auto"` | `ColumnDefinitions="*,Auto"` |
| Styling | `Style` + triggers | CSS-like selectors | `Style TargetType` + `VisualStateManager` |
| Compiled bindings | No (reflection) | `x:DataType` + `x:CompileBindings` | `x:DataType` (warnings when missing) |

A tiny MAUI page, so you can see the vocabulary together:

```xml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:vm="clr-namespace:QuestBoard.Mobile.ViewModels"
             x:Class="QuestBoard.Mobile.Views.NewQuestPage"
             x:DataType="vm:NewQuestViewModel"
             Title="New quest">
  <VerticalStackLayout Padding="16" Spacing="8">
    <Label Text="Title" />
    <Entry Text="{Binding Title}" Placeholder="Slay the bug" />
    <Button Text="Save" Command="{Binding SaveCommand}" HorizontalOptions="End" />
  </VerticalStackLayout>
</ContentPage>
```

- `x:DataType="vm:NewQuestViewModel"` turns on **compiled bindings**. The XAML compiler checks
  that `Title` and `SaveCommand` exist and generates direct property access instead of reflection.
  A typo becomes a build error, not a silent blank label. MAUI 10 warns about bindings that
  can't be compiled, so treat those warnings as errors.
- `Entry.Text` binds **two-way** by default, as `TextBox.Text` does in Avalonia: typing updates the
  view model.
- The view model is the same CommunityToolkit.Mvvm code you wrote for Avalonia (`[ObservableProperty]`,
  `[RelayCommand]`). **View models are the part you can share** between an Avalonia desktop app and a
  MAUI phone app.

MAUI also has markup extensions for per-device differences:

```xml
<!-- More padding on iOS (notch), less elsewhere; bigger font on tablets -->
<VerticalStackLayout Padding="{OnPlatform iOS='16,48,16,16', Default='16'}">
  <Label Text="Quests" FontSize="{OnIdiom Phone=24, Tablet=32, Desktop=28}" />
  <Label Text="Dark-mode aware" TextColor="{AppThemeBinding Light=Black, Dark=White}" />
</VerticalStackLayout>
```

:::quiz id=dsk-09-q3 xp=10
You port this Avalonia snippet to MAUI. Which version is correct MAUI XAML?

```xml
<StackPanel>
  <TextBlock Text="{Binding Title}" HorizontalAlignment="Center" />
  <TextBox Text="{Binding Notes}" />
</StackPanel>
```
- [ ] Unchanged: MAUI accepts Avalonia control names
- [x] `<VerticalStackLayout><Label Text="{Binding Title}" HorizontalOptions="Center" /><Entry Text="{Binding Notes}" /></VerticalStackLayout>`
- [ ] `<StackLayout><TextBlock Text="{Binding Title}" HorizontalOptions="Center" /><TextBox Text="{Binding Notes}" /></StackLayout>`
- [ ] `<VerticalStackLayout><Label Text="{Binding Title}" HorizontalAlignment="Center" /><Entry Text="{Binding Notes}" /></VerticalStackLayout>`
> MAUI uses its own controls: `TextBlock` becomes `Label`, `TextBox` becomes `Entry`, and the
> vertical `StackPanel` becomes `VerticalStackLayout`. Alignment is `HorizontalOptions` (values `Start`,
> `Center`, `End`, `Fill`), not `HorizontalAlignment`. The last option mixes both and fails with
> "property not found". The binding syntax itself carries over unchanged.
:::

## Pages, layouts and controls

MAUI sorts UI types into three groups:

- **Pages** fill the screen. `ContentPage` is the one you use 95 % of the time. `TabbedPage`,
  `FlyoutPage` and `NavigationPage` exist, but in a Shell app **Shell** gives you tabs, flyout and
  navigation instead.
- **Layouts** arrange children: `Grid` (rows/columns, star sizing like Avalonia),
  `VerticalStackLayout` / `HorizontalStackLayout`, `FlexLayout` (wrapping, like CSS flexbox),
  `AbsoluteLayout`, and `ScrollView` for content taller than the screen.
- **Controls (views)** are the leaves: `Label`, `Button`, `Entry`, `Editor`, `CheckBox`, `Switch`,
  `Picker`, `DatePicker`, `Image`, `ActivityIndicator`, `CollectionView`, `RefreshView`
  (pull-to-refresh), `SwipeView` (swipe a row for actions).

```xml
<!-- A quest row: title takes the remaining width (*), XP takes what it needs (Auto) -->
<Grid ColumnDefinitions="*,Auto" Padding="12">
  <Label Text="Run on an emulator" VerticalOptions="Center" />
  <Label Grid.Column="1" Text="30 XP" VerticalOptions="Center" />
</Grid>
```

:::tip title="CollectionView, not ListView"
`ListView` is the old Xamarin.Forms list and is deprecated in MAUI. Use `CollectionView`. It
virtualises (creates only the rows on screen), supports grids and selection, and works with
`RefreshView` and `SwipeView`. And never put a `CollectionView` inside a `ScrollView` or a
`VerticalStackLayout`: it gets infinite height, renders every row and scrolls badly.
:::

## Shell: navigation with routes

On a phone, users go **forward** into detail screens and **back** with a gesture or the system back
button. Each app needs a **navigation stack** (the list of pages you went through, newest on top).
Shell manages it, and lets you navigate with **URIs**, much like a web router.

```xml
<!-- AppShell.xaml: the visual hierarchy -->
<Shell ...>
  <TabBar>
    <ShellContent Title="Quests" Route="quests" ContentTemplate="{DataTemplate views:QuestListPage}" />
    <ShellContent Title="About"  Route="about"  ContentTemplate="{DataTemplate views:AboutPage}" />
  </TabBar>
</Shell>
```

```csharp
// AppShell.xaml.cs: detail pages that aren't tabs get a *registered route*
Routing.RegisterRoute("questdetail", typeof(QuestDetailPage));
```

There are two kinds of routes:

- **Visual hierarchy routes** are declared in `AppShell.xaml` (tabs, flyout items, the `Route`
  attribute). They're the roots of navigation.
- **Registered (global) routes** are pages you *push* onto the stack, registered in code with
  `Routing.RegisterRoute`.

Navigating is one call, `Shell.Current.GoToAsync(uri)`. The table assumes a second page,
`questedit`, is registered the same way as `questdetail`:

| URI | Meaning | Stack before → after |
|---|---|---|
| `//about` | **Absolute** (`//`): jump to a root route; you land on its root page | `quests / questdetail` → `about` |
| `questdetail` | **Relative**: push a registered route | `quests` → `quests / questdetail` |
| `questdetail?id=7` | Push and pass a **query parameter** `id = "7"` | `quests` → `quests / questdetail` |
| `..` | Go back one page | `quests / questdetail` → `quests` |
| `../questedit` | Back one page, then push `questedit` | `quests / questdetail` → `quests / questedit` |
| `//quests/questdetail?id=3` | Absolute: root, then push, with a parameter | anything → `quests / questdetail` |

**Query parameters** are how a list tells the detail page *which* item to show, like `?id=7` on a
web URL. The receiving page (or its view model) implements `IQueryAttributable`:

```csharp
public partial class QuestDetailViewModel : ObservableObject, IQueryAttributable
{
    public void ApplyQueryAttributes(IDictionary<string, object> query)
    {
        var id = int.Parse(Uri.UnescapeDataString(query["id"].ToString()!)); // "7" → 7
        // load the quest with that id…
    }
}
```

Values from the URI string arrive as **strings**, and with `IQueryAttributable` they are **not**
URL-decoded for you. Use `Uri.UnescapeDataString`, or build the URI with `Uri.EscapeDataString`
when a value can contain spaces or `&`. To pass whole objects instead of strings, use the dictionary
overload: `GoToAsync("questdetail", new Dictionary<string, object> { ["quest"] = quest })`.
An alternative to `IQueryAttributable` is the `[QueryProperty(nameof(Id), "id")]` attribute on the
class, which copies the `id` parameter into an `Id` property; it is simpler but uses reflection, so
`IQueryAttributable` is the trimming-friendly choice.

:::quiz id=dsk-09-q4 xp=10
The stack is `quests / questdetail`. You call `GoToAsync("//about")`. What does the back button do
on the `about` page?
- [ ] Goes back to `questdetail`
- [ ] Goes back to `quests`
- [x] Nothing to go back to: `//` replaced the whole stack with the `about` root
- [ ] Throws, because `about` was never pushed
> A `//` prefix makes the route **absolute**: Shell switches to that root item, and the stack you see
> is just that root page, so there is nothing to go back to. Use it for "go home" or switching tabs
> from code. Relative routes (`questdetail`, `..`) push or pop on the current stack instead.
:::

:::quiz id=dsk-09-q5 xp=10
Which of these navigations are valid in the QuestBoard Shell (tabs `quests`, `about`; registered
route `questdetail`)? Select all that apply.
- [x] From `quests`: `GoToAsync("questdetail?id=2")`
- [x] From anywhere: `GoToAsync("//quests/questdetail?id=2")`
- [ ] From `quests`: `GoToAsync("//questdetail")`
- [x] From `quests / questdetail`: `GoToAsync("..")`
> `questdetail` is a **registered** route, so it can be pushed relatively or after an absolute root
> (`//quests/questdetail`). It can't be the root itself: `//questdetail` fails, because a
> registered route can't be the only page on the stack (Shell throws "Global routes currently cannot
> be the only page on the stack"). `..` pops back to `quests`.
:::

### Simulate it: a Shell route resolver

Shell's rules are easier to remember once you've implemented them. This TypeScript challenge
simulates Shell's URI handling. The real thing is C#, but the logic is the same.

:::challenge id=dsk-09-c1 lang=ts xp=50
title: Shell route resolver with query parameters
Write `goTo(shell, stack, uri)` that returns the new navigation stack and the query parameters, like
`Shell.GoToAsync` does.

- `shell.roots`: root routes from `AppShell.xaml` (e.g. `['quests', 'about']`).
- `shell.registered`: routes registered with `Routing.RegisterRoute` (e.g. `['questdetail', 'questedit']`).
- `stack`: the current stack of route names, root first (e.g. `['quests', 'questdetail']`). Don't mutate it.
- `uri`: `path` optionally followed by `?key=value&key2=value2`. Everything after the **first** `?`
  is the query.

Rules:

1. **Absolute** (`//a/b/c`): ignore the current stack. The first segment must be a root; every
   following segment must be a registered route. The new stack is exactly those segments.
2. **Relative** (no `//`): start from a **copy** of `stack` and apply each `/`-separated segment in
   order (skip empty segments). `..` pops one page; a registered route is pushed. A root name is
   **not** allowed here.
3. Errors (throw an `Error`):
   - a segment that is unknown, or a known route in the wrong place (a registered route as the
     absolute root, a root pushed relatively): message `Unknown route: <segment>`, e.g.
     `Unknown route: about`;
   - `..` when only the root is left: message `Cannot go back from root`;
   - `//` with no segments at all: throw any `Error` (not tested).
4. Query: split on `&`, then split each pair on its **first** `=` only (so `a=b=c` is key `a`,
   value `b=c`). Decode keys and values with `decodeURIComponent`. A pair without `=` gets the value
   `''`. No query → `{}`.

Return `{ stack, params }` (`params` is a plain object of strings).

hint: `const [path, query = ''] = uri.split('?', 2)` is not quite enough if `?` appears twice. Use `indexOf('?')` and `slice`.
hint: For the absolute case: `path.slice(2).split('/').filter(Boolean)`.
hint: For `a=b=c`, use `const i = pair.indexOf('=')`; the key is `pair.slice(0, i)` and the value is `pair.slice(i + 1)`.

```ts starter
type Shell = { roots: string[]; registered: string[] }
type Nav = { stack: string[]; params: Record<string, string> }

export function goTo(shell: Shell, stack: string[], uri: string): Nav {
  // your code
  return { stack, params: {} }
}
```

```ts solution
type Shell = { roots: string[]; registered: string[] }
type Nav = { stack: string[]; params: Record<string, string> }

function parseQuery(query: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const i = pair.indexOf('=')
    const key = i === -1 ? pair : pair.slice(0, i)
    const value = i === -1 ? '' : pair.slice(i + 1)
    params[decodeURIComponent(key)] = decodeURIComponent(value)
  }
  return params
}

export function goTo(shell: Shell, stack: string[], uri: string): Nav {
  const q = uri.indexOf('?')
  const path = q === -1 ? uri : uri.slice(0, q)
  const query = q === -1 ? '' : uri.slice(q + 1)

  let next: string[]
  if (path.startsWith('//')) {
    const segments = path.slice(2).split('/').filter(Boolean)
    if (segments.length === 0) throw new Error('Unknown route: ')
    segments.forEach((seg, i) => {
      const ok = i === 0 ? shell.roots.includes(seg) : shell.registered.includes(seg)
      if (!ok) throw new Error(`Unknown route: ${seg}`)
    })
    next = segments
  } else {
    next = [...stack]
    for (const seg of path.split('/').filter(Boolean)) {
      if (seg === '..') {
        if (next.length <= 1) throw new Error('Cannot go back from root')
        next.pop()
      } else if (shell.registered.includes(seg)) {
        next.push(seg)
      } else {
        throw new Error(`Unknown route: ${seg}`)
      }
    }
  }
  return { stack: next, params: parseQuery(query) }
}
```

```ts tests
const shell = { roots: ['quests', 'about'], registered: ['questdetail', 'questedit'] }

test('relative push with a query parameter', () => {
  expect(goTo(shell, ['quests'], 'questdetail?id=7')).toEqual({
    stack: ['quests', 'questdetail'],
    params: { id: '7' },
  })
})
test('does not mutate the current stack', () => {
  const current = ['quests']
  goTo(shell, current, 'questdetail')
  expect(current).toEqual(['quests'])
})
test('.. pops one page', () => {
  expect(goTo(shell, ['quests', 'questdetail'], '..').stack).toEqual(['quests'])
})
test('../questedit pops then pushes', () => {
  expect(goTo(shell, ['quests', 'questdetail'], '../questedit').stack).toEqual(['quests', 'questedit'])
})
test('absolute route replaces the stack', () => {
  expect(goTo(shell, ['quests', 'questdetail', 'questedit'], '//about')).toEqual({ stack: ['about'], params: {} })
})
test('absolute root plus registered route', () => {
  expect(goTo(shell, ['about'], '//quests/questdetail?id=3').stack).toEqual(['quests', 'questdetail'])
})
test('a registered route cannot be an absolute root', () => {
  expect(() => goTo(shell, ['quests'], '//questdetail')).toThrow('Unknown route: questdetail')
})
test('a root cannot be pushed relatively', () => {
  expect(() => goTo(shell, ['quests'], 'about')).toThrow('Unknown route: about')
})
test('unknown routes throw', () => {
  expect(() => goTo(shell, ['quests'], 'settings')).toThrow('Unknown route: settings')
})
test('cannot pop the root', () => {
  expect(() => goTo(shell, ['quests'], '..')).toThrow('Cannot go back from root')
})
test('several parameters, decoding, first = only, key without value', () => {
  expect(goTo(shell, ['quests'], 'questedit?title=Slay%20the%20bug&expr=a%3Db=c&draft').params).toEqual({
    title: 'Slay the bug',
    expr: 'a=b=c',
    draft: '',
  })
})
```
:::

:::pro title="Wrap Shell behind a navigation service"
Calling `Shell.Current.GoToAsync` straight from view models works, but it ties them to a static UI
object you can't unit test. Real teams inject an `INavigationService` with
`Task GoToAsync(string route, IDictionary<string, object>? args = null)`. In the app it calls Shell,
and in tests it's a fake that records the route. They also keep route names in constants
(`Routes.QuestDetail = "questdetail"`), so a typo becomes a compile error.
:::

## Running it: emulators, simulators, Windows

A **TFM** chooses the platform; `-t:Run` builds, deploys and launches:

```bash
# Android emulator or USB device (Windows or macOS)
dotnet build -t:Run -f net10.0-android

# Windows desktop (Windows only)
dotnet build -t:Run -f net10.0-windows10.0.19041.0

# Mac Catalyst desktop app (macOS only)
dotnet build -t:Run -f net10.0-maccatalyst

# iOS simulator (macOS with Xcode only)
dotnet build -t:Run -f net10.0-ios
```

- **Android emulator**: a virtual phone from the Android SDK, configured as an **AVD** (Android
  Virtual Device). Visual Studio on Windows installs the SDK and an emulator for you (Tools →
  Android → Android Device Manager). On macOS, use Android Studio's Device Manager, or let MAUI
  install the dependencies (see the lab). Turn on hardware acceleration (Hyper-V/WHPX on Windows),
  or the emulator crawls.
- **iOS simulator**: part of Xcode, macOS only. Apple's license requires a Mac to build iOS apps. On
  Windows, Visual Studio can only build iOS apps by *pairing* with a Mac on the network.
- **Windows**: runs as a packaged WinUI 3 app (an MSIX package installed on your PC). Turn on
  **Developer Mode** in Windows Settings the first time.

:::warn title="Windows from the command line"
For the Windows target, tooling behaviour has changed between releases: if `dotnet build -t:Run`
builds but doesn't launch (or complains that the package must be deployed first), run it from
Visual Studio with F5, or run it unpackaged with
`dotnet run -f net10.0-windows10.0.19041.0 -p:WindowsPackageType=None`. Check the current
"Build and run from the command line" page in the .NET MAUI docs (learn.microsoft.com/dotnet/maui).
:::

**Hot reload** lets you change the app while it runs, without restarting:

- **XAML Hot Reload**: edit a `.xaml` file, save, and the running page updates. It works while you
  debug from an IDE (Visual Studio on Windows, VS Code with the .NET MAUI extension, or Rider), not
  from a plain `dotnet build -t:Run`. Great for layout tweaks.
- **.NET Hot Reload**: edit C# method bodies while debugging; the change applies the next time that
  method runs. Edits the runtime can't patch in place (called *rude edits*, for example changing a
  method's signature) need a restart. Code that already ran, such as `MauiProgram.CreateMauiApp`,
  can be patched but won't run again, so DI changes also need a restart.

:::info title="Which IDE?"
Windows: **Visual Studio 2026** with the *.NET Multi-platform App UI development* workload, or
VS Code with the **.NET MAUI** extension (C# Dev Kit). macOS: VS Code with the .NET MAUI extension
plus Xcode (Visual Studio for Mac was retired in 2024). JetBrains **Rider** also supports MAUI on both.
:::

:::quiz id=dsk-09-q6 xp=10
A teammate on Linux runs `dotnet workload install maui` and wants to run QuestBoard on the iOS
simulator. What should you tell them?
- [ ] Use `-f net10.0-linux`; Linux is a MAUI target since .NET 9
- [ ] Install Xcode via Wine, then `dotnet build -t:Run -f net10.0-ios`
- [x] MAUI apps can't be built on Linux; iOS needs a Mac with Xcode, so use a Mac (or a Windows PC paired to one)
- [ ] Only XAML Hot Reload is missing on Linux; builds work
> MAUI has no Linux target and doesn't support building on Linux. iOS and Mac Catalyst builds need
> Xcode, which only runs on macOS. Windows can build iOS apps only by pairing with a Mac. For a
> cross-platform UI that *runs* on Linux desktops, the answer is Avalonia (earlier in this region).
:::

:::quiz id=dsk-09-q7 xp=10
During a debug session on the Android emulator you change three things. Which ones apply **without**
restarting the app?
- [x] Changing a `Label`'s `FontSize` in `QuestListPage.xaml`
- [x] Changing the body of `OpenQuest` in the view model
- [ ] Registering a new service in `MauiProgram.CreateMauiApp`
> XAML Hot Reload updates XAML on save, and .NET Hot Reload patches C# **method bodies** on the
> next call. `MauiProgram` ran once at start-up to build the DI container and never runs again, so a
> new registration needs a restart. The same goes for "rude edits" such as changed method signatures.
:::

:::job title="What MAUI work looks like on day one"
Expect a Shell app with 10–40 pages, view models on CommunityToolkit.Mvvm, an API client talking to
the company backend, and a few files in `Platforms/` for push notifications or a barcode scanner.
Most of your tickets are "add a page + route + view model", "this binding doesn't update" (missing
`[ObservableProperty]` or a missing `x:DataType`), or "works on Android, broken on iOS". Always test
on **both** a real Android device and the iOS simulator before closing a ticket.
:::

:::pro title="MAUI 10 XAML source generation"
Since .NET 10, MAUI can compile XAML with a **source generator** instead of loading it at runtime
(`<MauiXamlInflator>SourceGen</MauiXamlInflator>` in the csproj). Pages start faster, and you get
better errors and debugging. Combine it with compiled bindings (`x:DataType` everywhere) and
**trimming** (the build removes code your app never uses) for **Native AOT** (compiling C# to
machine code ahead of time, which iOS requires anyway and which makes start-up faster). Seniors turn
the "binding could not be compiled" warnings into errors with
`<WarningsAsErrors>XC0022;XC0025</WarningsAsErrors>`. The property name and its default can change
between releases, so check the ".NET MAUI 10 what's new" page on learn.microsoft.com before you rely
on it.
:::

## Lab: QuestBoard Mobile

:::lab id=dsk-09-lab1 xp=100
title: QuestBoard Mobile (Windows or macOS)
Build a two-tab Shell app: a **Quests** list, a **quest detail** page reached through a route with
`?id=`, a **Complete quest** command with `CanExecute`, and an **About** tab. Pages and view models
come from DI.

:::warn
This lab cannot be built on Linux. Do it on **Windows** (Android emulator or Windows target) or
**macOS** (Android emulator, iOS simulator or Mac Catalyst). You verify it on Windows/macOS yourself.
:::

**1. Install the workload and create the project**

```bash
dotnet --version                 # 10.0.x
dotnet workload install maui     # on Windows: run in an elevated terminal
dotnet new maui -n QuestBoard.Mobile
cd QuestBoard.Mobile
dotnet add package CommunityToolkit.Mvvm --version 8.4.2
```

On macOS without Android Studio, install the Android SDK and Java through MAUI (paths are examples):

```bash
dotnet build -t:InstallAndroidDependencies -f net10.0-android \
  "-p:AndroidSdkDirectory=$HOME/Library/Android/sdk" \
  "-p:JavaSdkDirectory=$HOME/Library/Java/jdk" \
  "-p:AcceptAndroidSDKLicenses=True"
```

Delete the sample page, then create the folders:

```bash
# macOS / Git Bash
rm MainPage.xaml MainPage.xaml.cs
mkdir Models Services ViewModels Views
```

```powershell
# Windows PowerShell
Remove-Item MainPage.xaml, MainPage.xaml.cs
mkdir Models, Services, ViewModels, Views
```

**2. `Models/Quest.cs`**: an observable model, so the list updates when a quest is completed

```csharp
using CommunityToolkit.Mvvm.ComponentModel;

namespace QuestBoard.Mobile.Models;

public partial class Quest : ObservableObject
{
    public required int Id { get; init; }
    public required string Title { get; init; }
    public required int Xp { get; init; }

    [ObservableProperty]
    public partial bool Done { get; set; }
}
```

**3. `Services/QuestStore.cs`**: in-memory data, registered as a singleton

```csharp
using System.Collections.ObjectModel;
using QuestBoard.Mobile.Models;

namespace QuestBoard.Mobile.Services;

public sealed class QuestStore
{
    public ObservableCollection<Quest> Quests { get; } =
    [
        new Quest { Id = 1, Title = "Install the MAUI workload", Xp = 20 },
        new Quest { Id = 2, Title = "Run on an emulator", Xp = 30 },
        new Quest { Id = 3, Title = "Navigate with Shell", Xp = 50 },
    ];

    public Quest? Find(int id) => Quests.FirstOrDefault(q => q.Id == id);
}
```

**4. `ViewModels/QuestListViewModel.cs`**

```csharp
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QuestBoard.Mobile.Models;
using QuestBoard.Mobile.Services;

namespace QuestBoard.Mobile.ViewModels;

public partial class QuestListViewModel(QuestStore store) : ObservableObject
{
    public ObservableCollection<Quest> Quests => store.Quests;

    // Bound two-way to CollectionView.SelectedItem
    [ObservableProperty]
    public partial Quest? Selected { get; set; }

    partial void OnSelectedChanged(Quest? value)
    {
        if (value is null) return;
        Selected = null;                       // clear, so tapping the same row again works
        OpenQuestCommand.Execute(value);
    }

    [RelayCommand]
    private Task OpenQuest(Quest quest) =>
        Shell.Current.GoToAsync($"questdetail?id={quest.Id}");
}
```

**5. `ViewModels/QuestDetailViewModel.cs`**: receives `?id=` and offers a command with `CanExecute`

```csharp
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QuestBoard.Mobile.Models;
using QuestBoard.Mobile.Services;

namespace QuestBoard.Mobile.ViewModels;

public partial class QuestDetailViewModel(QuestStore store) : ObservableObject, IQueryAttributable
{
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(CompleteCommand))]
    public partial Quest? CurrentQuest { get; set; }

    public void ApplyQueryAttributes(IDictionary<string, object> query)
    {
        if (query.TryGetValue("id", out var raw)
            && int.TryParse(Uri.UnescapeDataString(raw?.ToString() ?? ""), out var id))
        {
            CurrentQuest = store.Find(id);
        }
    }

    private bool CanComplete() => CurrentQuest is { Done: false };

    [RelayCommand(CanExecute = nameof(CanComplete))]
    private async Task Complete()
    {
        CurrentQuest!.Done = true;
        await Shell.Current.GoToAsync("..");
    }
}
```

**6. `Views/QuestListPage.xaml`** and its code-behind

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:vm="clr-namespace:QuestBoard.Mobile.ViewModels"
             xmlns:models="clr-namespace:QuestBoard.Mobile.Models"
             x:Class="QuestBoard.Mobile.Views.QuestListPage"
             x:DataType="vm:QuestListViewModel"
             Title="Quests">
    <CollectionView ItemsSource="{Binding Quests}"
                    SelectionMode="Single"
                    SelectedItem="{Binding Selected, Mode=TwoWay}"
                    Margin="16">
        <CollectionView.ItemTemplate>
            <DataTemplate x:DataType="models:Quest">
                <Grid ColumnDefinitions="*,Auto" Padding="12" ColumnSpacing="8">
                    <Label Text="{Binding Title}" FontSize="18" VerticalOptions="Center" />
                    <HorizontalStackLayout Grid.Column="1" Spacing="8" VerticalOptions="Center">
                        <Label Text="Done" TextColor="Green" IsVisible="{Binding Done}" />
                        <Label Text="{Binding Xp, StringFormat='{0} XP'}" />
                    </HorizontalStackLayout>
                </Grid>
            </DataTemplate>
        </CollectionView.ItemTemplate>
    </CollectionView>
</ContentPage>
```

```csharp
// Views/QuestListPage.xaml.cs
using QuestBoard.Mobile.ViewModels;

namespace QuestBoard.Mobile.Views;

public partial class QuestListPage : ContentPage
{
    public QuestListPage(QuestListViewModel vm)
    {
        InitializeComponent();
        BindingContext = vm;
    }
}
```

**7. `Views/QuestDetailPage.xaml`** and its code-behind

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:vm="clr-namespace:QuestBoard.Mobile.ViewModels"
             x:Class="QuestBoard.Mobile.Views.QuestDetailPage"
             x:DataType="vm:QuestDetailViewModel"
             Title="Quest">
    <VerticalStackLayout Padding="24" Spacing="12">
        <Label Text="{Binding CurrentQuest.Title}" FontSize="24" FontAttributes="Bold" />
        <Label Text="{Binding CurrentQuest.Xp, StringFormat='Reward: {0} XP'}" />
        <Button Text="Complete quest" Command="{Binding CompleteCommand}" />
    </VerticalStackLayout>
</ContentPage>
```

```csharp
// Views/QuestDetailPage.xaml.cs
using QuestBoard.Mobile.ViewModels;

namespace QuestBoard.Mobile.Views;

public partial class QuestDetailPage : ContentPage
{
    public QuestDetailPage(QuestDetailViewModel vm)
    {
        InitializeComponent();
        BindingContext = vm;
    }
}
```

**8. `Views/AboutPage.xaml`** and its code-behind (no view model, parameterless constructor)

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="QuestBoard.Mobile.Views.AboutPage"
             Title="About">
    <VerticalStackLayout Padding="24" Spacing="8">
        <Label Text="QuestBoard Mobile" FontSize="24" FontAttributes="Bold" />
        <Label Text="{OnPlatform Android='Running on Android', iOS='Running on iOS', WinUI='Running on Windows', MacCatalyst='Running on macOS'}" />
    </VerticalStackLayout>
</ContentPage>
```

```csharp
// Views/AboutPage.xaml.cs
namespace QuestBoard.Mobile.Views;

public partial class AboutPage : ContentPage
{
    public AboutPage() => InitializeComponent();
}
```

**9. Replace `AppShell.xaml` and `AppShell.xaml.cs`**

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<Shell x:Class="QuestBoard.Mobile.AppShell"
       xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
       xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
       xmlns:views="clr-namespace:QuestBoard.Mobile.Views"
       Shell.FlyoutBehavior="Disabled"
       Title="QuestBoard">
    <TabBar>
        <ShellContent Title="Quests" Route="quests"
                      ContentTemplate="{DataTemplate views:QuestListPage}" />
        <ShellContent Title="About" Route="about"
                      ContentTemplate="{DataTemplate views:AboutPage}" />
    </TabBar>
</Shell>
```

```csharp
using QuestBoard.Mobile.Views;

namespace QuestBoard.Mobile;

public partial class AppShell : Shell
{
    public AppShell()
    {
        InitializeComponent();
        Routing.RegisterRoute("questdetail", typeof(QuestDetailPage));
    }
}
```

Leave `App.xaml.cs` as the template made it. It already creates the window with
`new Window(new AppShell())` in `CreateWindow`.

**10. Replace `MauiProgram.cs`**

```csharp
using Microsoft.Extensions.Logging;
using QuestBoard.Mobile.Services;
using QuestBoard.Mobile.ViewModels;
using QuestBoard.Mobile.Views;

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

        builder.Services.AddSingleton<QuestStore>();
        builder.Services.AddTransient<QuestListViewModel>();
        builder.Services.AddTransient<QuestListPage>();
        builder.Services.AddTransient<QuestDetailViewModel>();
        builder.Services.AddTransient<QuestDetailPage>();

#if DEBUG
        builder.Logging.AddDebug();
#endif

        return builder.Build();
    }
}
```

**11. Build and run**

```bash
# Windows (if it builds but does not launch, see "Windows from the command line" above)
dotnet build -t:Run -f net10.0-windows10.0.19041.0
# Windows or macOS, with an Android emulator running
dotnet build -t:Run -f net10.0-android
# macOS
dotnet build -t:Run -f net10.0-ios
dotnet build -t:Run -f net10.0-maccatalyst
```

Expected: the build ends with `Build succeeded.` and **0 warnings** about bindings (if you see
`XC0022`, an `x:DataType` is missing). The app opens on the **Quests** tab with three rows:
"Install the MAUI workload 20 XP", "Run on an emulator 30 XP", "Navigate with Shell 50 XP". Tapping
"Run on an emulator" opens **Quest** with "Reward: 30 XP". **Complete quest** returns to the list,
where that row now shows a green "Done". Open it again and the button is disabled.

:::tip
While the app runs from your IDE, change `FontSize="18"` in `QuestListPage.xaml` to `22` and save.
XAML Hot Reload should update the list without a restart.
:::

- [ ] `dotnet build -t:Run` works for at least one target (Android, Windows, iOS or Mac Catalyst) on Windows/macOS
- [ ] Tapping a quest navigates to `questdetail?id=…` and shows the right title and reward
- [ ] **Complete quest** goes back (`..`), the row shows "Done", and the button is disabled on that quest afterwards
- [ ] The **About** tab shows the platform text from `OnPlatform`
- [ ] Removing `AddTransient<QuestDetailViewModel>()` makes tapping a quest fail at runtime with "Unable to resolve service for type … QuestDetailViewModel" (then put it back)
:::

:::cards id=dsk-09-cards1 xp=15 title=".NET MAUI fundamentals"
Q: How does MAUI render a Button, compared with Avalonia?
A: MAUI maps it to the native platform control (Android Button, UIButton, WinUI Button). Avalonia draws it itself with Skia.
Q: What is the MAUI single project?
A: One .csproj that multi-targets several TFMs (net10.0-android, -ios, -maccatalyst, -windows…), with shared Resources/ and per-platform code in Platforms/<Name>/.
Q: Can you build MAUI apps on Linux?
A: No. There's no Linux target and no Linux build support. iOS and Mac Catalyst need a Mac with Xcode; Windows needs Windows.
Q: What does MauiProgram.CreateMauiApp do?
A: It's the host builder: UseMauiApp<App>, fonts, logging and DI registrations, then Build(). Every platform entry point calls it.
Q: Why register pages in DI?
A: Shell resolves pages from the container, so registration sets each page's lifetime explicitly. Every constructor parameter (e.g. the view model) must be registered, or navigation throws InvalidOperationException at runtime.
Q: Absolute vs relative Shell routes?
A: `//root/...` replaces the whole stack, starting from a visual-hierarchy root. A relative route (`detail`, `..`) pushes or pops on the current stack.
Q: How does a detail page receive `?id=7`?
A: Implement IQueryAttributable (ApplyQueryAttributes) on the page or its view model, or use [QueryProperty]. URI values are strings; decode them yourself with IQueryAttributable.
Q: MAUI names for TextBlock, TextBox, StackPanel and HorizontalAlignment?
A: Label, Entry (Editor for multi-line), VerticalStackLayout and HorizontalOptions.
Q: What does x:DataType give you in MAUI?
A: Compiled bindings: the XAML compiler checks binding paths at build time and skips reflection. Missing ones produce XC0022 warnings.
Q: Command to run on the Android emulator?
A: `dotnet build -t:Run -f net10.0-android`
:::

## Recap

- MAUI wraps **native controls** for Android, iOS, Mac Catalyst and Windows from **one multi-targeted
  project**. Per-platform code lives in `Platforms/`, and shared assets in `Resources/`.
- **Linux cannot build MAUI apps**; iOS/Mac need a Mac with Xcode. For Linux desktops, use Avalonia.
- `MauiProgram.CreateMauiApp` is the host builder. Register stores as singletons, and pages and view
  models as transients. Everything a page's constructor asks for must be registered, or navigation
  fails at runtime.
- MAUI XAML is the same language with a different vocabulary (`Label`, `Entry`,
  `VerticalStackLayout`, `HorizontalOptions`, `CollectionView`). Use `x:DataType` for compiled bindings.
- **Shell** navigates with URIs: `//root` replaces the stack, `detail?id=7` pushes with a query
  parameter, `..` pops. Detail pages read parameters via `IQueryAttributable`.
- Run with `dotnet build -t:Run -f <tfm>`. XAML and .NET Hot Reload cover layout and method-body
  changes; DI changes need a restart.
- CommunityToolkit.Mvvm view models carry over unchanged from Avalonia, and they're the shareable layer
  between desktop and mobile.
