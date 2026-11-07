---
id: dsk-02
title: "The .NET UI Landscape: WPF, WinUI, Avalonia, MAUI, Uno"
level: beginner
minutes: 60
xp: 100
summary: Where every .NET UI framework came from, how each one draws pixels, and how to pick the right one for a job.
---

## Why so many frameworks?

Open a job board and search for ".NET desktop". You'll see WinForms, WPF, UWP, WinUI 3, Xamarin,
MAUI, Avalonia, Uno and Blazor Hybrid, sometimes several in one posting. That looks like chaos, but
there's a simple story behind it: **every framework was Microsoft's (or the community's) answer to
the platforms that mattered at the time.** In 2002 that was just Windows. In 2015 it was "Windows
on every device". Today an app is expected to run on Windows, macOS, Linux, phones and sometimes the
browser.

Old frameworks don't die when new ones arrive, because companies have millions of lines of working
code in them. So you need two skills:

1. **Reading the past.** You'll maintain an existing app, usually WPF.
2. **Choosing the future.** Sooner or later someone asks "what should we build the new client in?"

This lesson gives you the map. The rest of the region teaches the tools in depth with the running
example app **QuestBoard** (a small quest/task tracker), and the boss fight builds a **BranchStory
reader** client against the Capstone API.

### Words you need first

| Term | Meaning | Tiny example |
| --- | --- | --- |
| **UI framework** | A library that gives you windows, buttons, layout, input and drawing | `new Button { Text = "Save" }` |
| **XAML** | XML-based markup for describing UI (eXtensible Application Markup Language) | `<Button Content="Save"/>` |
| **Code-behind** | The C# class paired with a XAML file (`MainWindow.xaml.cs`) | an `OnSaveClicked` handler |
| **Data binding** | The UI reads (and writes) properties of an object automatically | `Text="{Binding Title}"` |
| **MVVM** | Model–View–ViewModel: UI (View) binds to a plain C# class (ViewModel) that holds state and commands | `QuestListViewModel.Quests` |
| **Native control** | A widget the operating system draws, such as an Android `Button` or a macOS `NSButton` | MAUI's `Button` on iOS *is* a `UIButton` |
| **Self-drawn (rendered) UI** | The framework paints every pixel itself on a canvas | Avalonia draws its `Button` with Skia |
| **Skia** | Google's open-source 2D graphics engine (also used by Chrome and Flutter) | rectangles, text and paths on a GPU surface |
| **Workload** | An optional SDK add-on for extra platforms | `dotnet workload install maui` |
| **NuGet package** | A downloadable .NET library your project references by name and version | `<PackageReference Include="Avalonia" Version="12.1.5"/>` |
| **WebAssembly (WASM)** | A binary format browsers can run, so .NET code can run inside a web page | an Avalonia or Uno app opened at a URL |
| **Fluent** | Microsoft's current design language (rounded corners, soft shadows, Windows 11 look) | the Windows 11 Settings app |
| **Accessibility / IME** | Screen-reader support, and the *Input Method Editor* that lets people type Chinese, Japanese or Korean | a blind user hearing "Save, button" |

Here's the family tree you're about to walk through. An arrow means "was replaced by" or "led to":

```text
2002  WinForms ──────────────────────────────► still supported (Windows)
2006  WPF ───────────────────────────────────► still supported (Windows)
        ├─ 2007 Silverlight (browser plug-in) ✝ 2021
        ├─ 2013 Avalonia ("WPF, but everywhere") ► Windows, macOS, Linux, mobile, web
2011  Xamarin ── 2014 Xamarin.Forms ✝ 2024 ──► 2022 .NET MAUI (mobile + Windows + Mac)
2015  UWP (maintenance) ───► 2021 WinUI 3 / Windows App SDK (Windows)
                               └─ 2018 Uno Platform (WinUI API everywhere)
2022  Blazor Hybrid (web components in a native window)
```

## A short history, framework by framework

### WinForms (2002): drag, drop, double-click

Windows Forms shipped with .NET 1.0. It's a thin C# wrapper around the classic Win32 controls that
Windows itself draws. You drop controls on a designer and write event handlers:

```csharp
var button = new Button { Text = "Add quest", Left = 10, Top = 10 };
button.Click += (_, _) => MessageBox.Show("Quest added!");
form.Controls.Add(button);
```

- **Platforms:** Windows only.
- **Rendering:** native Win32 controls (GDI/GDI+).
- **Status:** open source since 2018, fully supported on .NET 10 and still getting improvements
  (for example dark-mode support and async APIs in .NET 9), very common in internal
  line-of-business tools ("LOB apps": the order-entry and admin tools a company builds for itself). There's no data-binding culture like in XAML, so logic tends to pile up in
  event handlers.

### WPF (2006): XAML, binding and hardware rendering

Windows Presentation Foundation (code name *Avalon*) came with .NET Framework 3.0. It introduced the
ideas the rest of this region builds on: **XAML**, **data binding**, **styles/templates** and
**resolution-independent vector rendering** through DirectX.

```xml
<StackPanel>
  <TextBox Text="{Binding NewQuestTitle}"/>
  <Button Content="Add quest" Command="{Binding AddQuestCommand}"/>
</StackPanel>
```

The button doesn't know *what* adding a quest means. It just calls a command on the ViewModel. That
separation is MVVM, and it was born in the WPF world.

- **Platforms:** Windows only.
- **Rendering:** self-drawn with DirectX. WPF doesn't use Win32 buttons. It paints its own, which is
  why you can restyle everything.
- **Status:** open source since 2018, runs on modern .NET (since .NET Core 3.0), actively maintained
  (for example, a Windows 11 Fluent theme arrived in .NET 9). **It's the framework you're most likely
  to meet in an existing company codebase.**

:::info title="Silverlight: the ghost in old docs"
Silverlight (2007) was a browser plug-in that ran a subset of WPF. Browsers dropped plug-ins and
support ended in 2021. You'll still see it in old Stack Overflow answers about XAML. The XAML ideas
carry over, but the plug-in itself is dead.
:::

### UWP (2015) and WinUI 3 / Windows App SDK (2021)

The **Universal Windows Platform** shipped with Windows 10: one app model for PC, Xbox, HoloLens
and Windows Phone, with a store-first, sandboxed design. Phones died, and the sandbox annoyed
desktop developers, so UWP is now in maintenance mode.

Microsoft then pulled UWP's modern UI layer out of the OS and shipped it as a NuGet package.
**WinUI 3** is that UI layer (Fluent controls, XAML), and the **Windows App SDK** (formerly
*Project Reunion*) is the bundle of WinUI 3 plus Windows APIs, usable from normal desktop (Win32)
apps. Because it ships as a package, not inside Windows, you get updates without waiting for an OS
release.

```xml
<!-- WinUI 3: almost the same XAML as WPF, different namespace and controls -->
<StackPanel Spacing="8">
  <TextBox PlaceholderText="Quest title" Text="{x:Bind ViewModel.NewQuestTitle, Mode=TwoWay}"/>
  <Button Content="Add quest" Command="{x:Bind ViewModel.AddQuestCommand}"/>
</StackPanel>
```

- **Platforms:** Windows 10/11 only.
- **Rendering:** self-drawn by the Windows composition engine, with a native Windows 11 look.
- **Status:** Microsoft's recommended framework for *new Windows-only* apps that want the newest
  Windows look.

### Xamarin (2011) → .NET MAUI (2022)

Xamarin let you write iOS and Android apps in C#. Microsoft bought it in 2016. **Xamarin.Forms**
added one shared XAML UI for both platforms. Xamarin support **ended in May 2024**.

Its successor is **.NET MAUI** (Multi-platform App UI), released with .NET 6 and now on version 10
with .NET 10. One project targets Android, iOS, macOS (via **Mac Catalyst**, Apple's
technology for running iPad-style apps on the Mac) and Windows (via WinUI 3).

```xml
<VerticalStackLayout Spacing="8">
  <Entry Placeholder="Quest title" Text="{Binding NewQuestTitle}"/>
  <Button Text="Add quest" Command="{Binding AddQuestCommand}"/>
</VerticalStackLayout>
```

- **Platforms:** Android, iOS, macOS, Windows. **No Linux**: Linux isn't a supported target, and
  you can't build MAUI apps on a Linux machine. The MAUI labs in this region are verified on
  Windows/macOS by the learner.
- **Rendering:** **native controls**. A *handler* (a small adapter class) maps each MAUI control to the platform widget, so
  `Button` becomes a `UIButton` on iOS, `MaterialButton` on Android and a WinUI `Button` on Windows.
- **Status:** Microsoft's official cross-platform mobile+desktop framework. Installed with
  `dotnet workload install maui`.

### Avalonia (2013 → 11.0 in 2023)

A community project (first named *Perspex*) that set out to be "WPF, but cross-platform". Its XAML
(`.axaml` files) is very close to WPF, and it draws everything itself with Skia, so an app looks and
behaves the same on every OS.

```xml
<StackPanel Spacing="8">
  <TextBox PlaceholderText="Quest title" Text="{Binding NewQuestTitle}"/>
  <Button Content="Add quest" Command="{Binding AddQuestCommand}"/>
</StackPanel>
```

- **Platforms:** Windows, macOS, **Linux**, Android, iOS and the browser (WebAssembly).
- **Rendering:** self-drawn (Skia). It's pixel-identical everywhere, but it doesn't look "native"
  unless you style it that way.
- **Status:** open source (MIT) with a company behind it. Version 11 (July 2023) was the big modern
  release; **12.x** (first released April 2026) is the current stable line and keeps the same XAML,
  binding and MVVM model. `dotnet new` templates installed today reference Avalonia 12.x. This region builds QuestBoard with Avalonia,
  because it builds and runs on Windows, macOS *and* Linux. Templates come from
  `dotnet new install Avalonia.Templates`. A commercial product, **Avalonia XPF**, runs existing WPF
  apps cross-platform.

:::warn title="Avalonia 11 vs 12 names"
Most tutorials online (and many company apps) are on Avalonia 11. A few names changed in 12, for
example the hint text in an empty `TextBox` is `PlaceholderText` in 12 and `Watermark` in 11 (still
compiles in 12 with an *obsolete* warning, AVLN5001). If an example from the web doesn't compile,
check the upgrade notes at https://docs.avaloniaui.net before assuming your code is wrong.
:::

### Uno Platform (2018)

Uno takes the **WinUI 3 API** (same XAML, same control names) and runs it on iOS, Android, macOS,
Linux and WebAssembly. It's attractive if you already know WinUI/UWP or need a strong browser
target.

- **Platforms:** Windows, iOS, Android, macOS, Linux and WebAssembly.
- **Rendering:** Skia-based self-drawing by default since Uno 6 (2025), with native rendering
  still available.
- **Status:** open source, commercially backed, with its own tooling (Uno.Sdk, Hot Design).

### Blazor Hybrid (2022)

**Blazor** is ASP.NET Core's component model: `.razor` files with HTML + C#. **Blazor Hybrid** hosts
those components in a `BlazorWebView` inside a MAUI, WPF or WinForms window. The UI is HTML/CSS
rendered by the OS web view, but the C# runs natively in the app process (no WebAssembly, full
access to the device and file system).

```razor
<input @bind="newQuestTitle" placeholder="Quest title" />
<button @onclick="AddQuest">Add quest</button>

@code {
    List<string> quests = new();
    string newQuestTitle = "";
    void AddQuest() => quests.Add(newQuestTitle);
}
```

- **Platforms:** whatever the host supports (MAUI hosts: Android, iOS, macOS, Windows; WPF and
  WinForms hosts: Windows).
- **Rendering:** a web view.
- **When it shines:** a team that already has a Blazor web app and wants to share its components
  with a desktop or mobile client.

:::quiz id=dsk-02-q1 xp=10
A colleague says: "MAUI is just Xamarin.Forms renamed, so our Xamarin.Forms 5 app is fine to keep
shipping as is." What's wrong with that?
- [ ] Nothing: Xamarin.Forms is still supported alongside MAUI
- [x] Xamarin support ended in May 2024; the app should migrate to .NET MAUI to keep getting fixes and store compliance
- [ ] Xamarin.Forms apps automatically become MAUI apps when you install .NET 10
- [ ] MAUI only supports Windows, so they must stay on Xamarin for mobile
> MAUI is Xamarin.Forms' **successor**, not a rename. Xamarin reached end of support in May 2024.
> New iOS/Android SDK requirements (which app stores enforce) won't be met, and security fixes stop.
> The migration is real work: new project format, handlers instead of renderers, namespace changes.
> MAUI targets Android, iOS, macOS and Windows.
:::

## How they draw pixels: the three rendering models

This is the most useful mental model in the lesson, because it explains most of the trade-offs.

| Model | Who draws the button? | Frameworks | Upside | Downside |
| --- | --- | --- | --- | --- |
| **Native controls** | The OS (UIKit, Android Views, Win32/WinUI) | WinForms, MAUI, Xamarin.Forms | Looks and feels 100 % native; accessibility and text input come from the OS | Each platform behaves slightly differently; custom looks are harder; bugs differ per platform |
| **Self-drawn** | The framework, on a canvas (DirectX, Skia) | WPF, WinUI 3, Avalonia, Uno (Skia), *and Flutter outside .NET* | Pixel-identical everywhere; restyle anything; fewer per-platform surprises | Not automatically native-looking; the framework must re-implement accessibility, IME, scrolling physics |
| **Web view** | A browser engine inside the app | Blazor Hybrid, *and Electron outside .NET* | Reuse web skills and components | Bigger memory footprint; feels "webby" unless polished |

Tiny example: put one `Button` in a MAUI app and an Avalonia app and run both on an iPhone and a
Windows PC. The MAUI button looks different on each (it *is* the platform's button). The Avalonia
button looks the same on both (Avalonia painted it).

:::quiz id=dsk-02-q2 xp=10
A designer hands you a heavily branded UI: custom-shaped buttons, gradients, identical on Windows,
macOS and Linux. Which rendering model makes that easiest?
- [ ] Native controls, because the OS handles all the drawing for you
- [x] Self-drawn, because the framework paints every pixel and templates can change any control's look
- [ ] Web view, because only HTML supports gradients
- [ ] It makes no difference; all models render identically
> With a self-drawn framework like Avalonia, a control template *is* the look, and it renders the
> same on every OS. Native controls fight you: each platform's button has its own shape, padding and
> states. A web view could do it too, but it's heavier and wasn't the best fit for a desktop app on
> three OSes.
:::

## The status board today

| Framework | Windows | macOS | Linux | Android / iOS | Browser | Rendering | Status |
| --- | :-: | :-: | :-: | :-: | :-: | --- | --- |
| WinForms | ✅ | – | – | – | – | Native | Supported, maintenance-focused |
| WPF | ✅ | – | – | – | – | Self-drawn (DirectX) | Supported, actively maintained |
| UWP | ✅ | – | – | – | – | Self-drawn | Maintenance only |
| WinUI 3 | ✅ | – | – | – | – | Self-drawn | Recommended for new Windows-only apps |
| Xamarin.Forms | – | – | – | ✅ | – | Native | **End of support (May 2024)** |
| .NET MAUI | ✅ | ✅ | ❌ | ✅ | – | Native | Microsoft's cross-platform choice |
| Avalonia | ✅ | ✅ | ✅ | ✅ | ✅ | Self-drawn (Skia) | Active, community + company |
| Uno Platform | ✅ | ✅ | ✅ | ✅ | ✅ | Skia (or native) | Active, community + company |
| Blazor Hybrid | ✅ | ✅* | – | ✅* | – | Web view | Active (*via a MAUI host) |

:::info title="A snapshot, not a law"
This board is accurate as of late 2026. Support status changes (that's how Xamarin and UWP got
here), so before a real decision check each project's official page: Microsoft's .NET support
policy at https://dotnet.microsoft.com/platform/support/policy, https://avaloniaui.net and
https://platform.uno.
:::

:::warn title="Linux is the deciding question"
If anyone on the requirements list says "Linux" (a lab PC, a kiosk, an embedded device, developers'
own machines), MAUI and WinUI are out. That single question narrows the field to **Avalonia** or
**Uno** faster than any feature comparison.
:::

:::quiz id=dsk-02-q3 xp=10
Your company sells a measurement device. Its control software must run on Windows laptops and on a
Linux industrial PC bolted to the machine. Which pair of frameworks is realistic?
- [ ] .NET MAUI or WinUI 3
- [ ] WPF or WinForms
- [x] Avalonia or Uno Platform
- [ ] Xamarin.Forms or Blazor Hybrid on MAUI
> Linux rules out MAUI (no Linux target), WinUI 3, WPF and WinForms (Windows only) and Xamarin
> (dead, mobile only). Avalonia and Uno both target Windows and Linux from one codebase. Avalonia is
> especially common in industrial/embedded Linux.
:::

## Choosing a framework for a job

Real decisions start from **requirements**, not taste. Ask these in order:

1. **Do we already have an app?** A working WPF app with 200 screens isn't rewritten for fun.
   Keep it, move it to modern .NET, and improve it.
2. **Which platforms?** Windows only, desktop on several OSes, mobile, browser?
3. **Native look or brand look?** Must it feel like an iOS app, or like *our* app?
4. **What does the team know?** Razor/Blazor web devs, WPF veterans, or mobile devs?
5. **Long-term support and hiring.** Who backs the framework? Can we hire people who know it?

| Situation | Typical pick | Why |
| --- | --- | --- |
| Existing WPF app, Windows only | **Keep WPF** on .NET 10 | Lowest risk; WPF is maintained; skills are common |
| New Windows-only app, modern Windows 11 look | **WinUI 3** | Native Fluent look, Microsoft's current Windows stack |
| Desktop on Windows + macOS + Linux | **Avalonia** | Mature, WPF-like XAML, self-drawn, Linux support |
| Mobile-first (iOS/Android), native look, plus a Windows/Mac build | **.NET MAUI** | Native controls, one project, official Microsoft support |
| WinUI skills, must also run in the browser | **Uno Platform** | WinUI API everywhere, strong WebAssembly target |
| Existing Blazor web app, want a desktop/mobile shell | **Blazor Hybrid** | Reuse Razor components |
| Small internal Windows tool, built fast | **WinForms** (or WPF) | Designer, quick to build, nobody cares about looks |

:::quiz id=dsk-02-q4 xp=10
A startup wants a new customer app for iPhone and Android that looks like a "real" app on each
phone, plus a Windows build for their support staff. The team is three C# developers. Best first
choice?
- [ ] WPF
- [ ] WinUI 3
- [x] .NET MAUI
- [ ] WinForms
> Mobile + native look + Windows is exactly MAUI's sweet spot: native controls on iOS and Android
> and a WinUI 3 build on Windows, all from one project. WPF, WinUI 3 and WinForms don't run on phones
> at all. Avalonia would also run there, but it draws its own controls, so "looks native on each
> phone" takes extra styling work.
:::

:::quiz id=dsk-02-q5 xp=10
Your team already ships a Blazor web app for booking appointments. Product now wants an installable
Windows and Android app with the same screens and offline access to local files. What's the
cheapest path?
- [x] Blazor Hybrid in a MAUI host, sharing the existing Razor components
- [ ] Rewrite all screens in WPF XAML
- [ ] Rewrite all screens in Avalonia XAML
- [ ] Ship the website inside a WinForms app using a WebBrowser control pointed at the URL
> Blazor Hybrid runs the same Razor components inside a native app (`BlazorWebView`), with C#
> running natively, so it can read local files. MAUI provides the Windows and Android hosts. A
> rewrite throws away working UI. Wrapping the live URL isn't offline and gives no native access.
:::

### Challenge: encode the decision table

Turning a fuzzy discussion into explicit rules is a senior skill. The rules below are a simplified
version of the table above. Write them as a function.

:::challenge id=dsk-02-c1 lang=ts xp=40
title: Pick a UI stack from requirements
Write `pickUiStack(req)` that returns one of `'WPF' | 'WinUI 3' | 'Avalonia' | '.NET MAUI' | 'Uno Platform' | 'Blazor Hybrid'`.

Apply these rules **in order**. The first rule that matches wins:

1. `platforms` is empty → throw an `Error` whose message contains `no platforms`.
2. `reuseBlazor` is true **and** `platforms` does not include `'linux'` → `'Blazor Hybrid'`.
3. `platforms` is exactly Windows only (`['windows']`): `existingWpf` → `'WPF'`, otherwise `'WinUI 3'`.
4. `platforms` includes `'web'` → `'Uno Platform'`.
5. `platforms` includes `'linux'` → `'Avalonia'`.
6. `platforms` includes `'android'` or `'ios'`: `nativeLook` → `'.NET MAUI'`, otherwise `'Avalonia'`.
7. Anything else (for example Windows + macOS desktop) → `'Avalonia'`.

Duplicates in `platforms` (like `['windows', 'windows']`) still count as "Windows only".

hint: Check the rules top to bottom with early `return`s. The order is what makes the logic simple.
hint: "Windows only" means every entry is `'windows'` (and there's at least one): `platforms.every(p => p === 'windows')`.
hint: `platforms.includes('linux')` reads well for rules 2, 4 and 5.

```ts starter
type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'
type Stack = 'WPF' | 'WinUI 3' | 'Avalonia' | '.NET MAUI' | 'Uno Platform' | 'Blazor Hybrid'

interface Requirements {
  platforms: Platform[]
  nativeLook: boolean
  existingWpf: boolean
  reuseBlazor: boolean
}

export function pickUiStack(req: Requirements): Stack {
  // apply the rules in order
  return 'WPF'
}
```

```ts solution
type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web'
type Stack = 'WPF' | 'WinUI 3' | 'Avalonia' | '.NET MAUI' | 'Uno Platform' | 'Blazor Hybrid'

interface Requirements {
  platforms: Platform[]
  nativeLook: boolean
  existingWpf: boolean
  reuseBlazor: boolean
}

export function pickUiStack(req: Requirements): Stack {
  const { platforms } = req
  if (platforms.length === 0) throw new Error('no platforms given')
  const has = (p: Platform) => platforms.includes(p)

  if (req.reuseBlazor && !has('linux')) return 'Blazor Hybrid'
  if (platforms.every((p) => p === 'windows')) return req.existingWpf ? 'WPF' : 'WinUI 3'
  if (has('web')) return 'Uno Platform'
  if (has('linux')) return 'Avalonia'
  if (has('android') || has('ios')) return req.nativeLook ? '.NET MAUI' : 'Avalonia'
  return 'Avalonia'
}
```

```ts tests
const base = { nativeLook: false, existingWpf: false, reuseBlazor: false }

test('empty platforms throws', () => {
  expect(() => pickUiStack({ ...base, platforms: [] })).toThrow('no platforms')
})
test('existing WPF app on Windows stays WPF', () => {
  expect(pickUiStack({ ...base, platforms: ['windows'], existingWpf: true })).toBe('WPF')
})
test('new Windows-only app is WinUI 3', () => {
  expect(pickUiStack({ ...base, platforms: ['windows'] })).toBe('WinUI 3')
})
test('duplicates still count as Windows only', () => {
  expect(pickUiStack({ ...base, platforms: ['windows', 'windows'] })).toBe('WinUI 3')
})
test('Linux desktop is Avalonia', () => {
  expect(pickUiStack({ ...base, platforms: ['windows', 'linux'] })).toBe('Avalonia')
})
test('existingWpf does not matter once other platforms are needed', () => {
  expect(pickUiStack({ ...base, platforms: ['windows', 'linux'], existingWpf: true })).toBe('Avalonia')
})
test('browser target is Uno Platform', () => {
  expect(pickUiStack({ ...base, platforms: ['windows', 'web'] })).toBe('Uno Platform')
})
test('web beats linux because rule 4 comes first', () => {
  expect(pickUiStack({ ...base, platforms: ['linux', 'web'] })).toBe('Uno Platform')
})
test('native-looking mobile app is MAUI', () => {
  expect(pickUiStack({ ...base, platforms: ['ios', 'android', 'windows'], nativeLook: true })).toBe('.NET MAUI')
})
test('branded mobile app is Avalonia', () => {
  expect(pickUiStack({ ...base, platforms: ['android'] })).toBe('Avalonia')
})
test('mobile + linux is Avalonia even with nativeLook', () => {
  expect(pickUiStack({ ...base, platforms: ['android', 'linux'], nativeLook: true })).toBe('Avalonia')
})
test('Blazor reuse wins when Linux is not needed', () => {
  expect(pickUiStack({ ...base, platforms: ['windows', 'android'], reuseBlazor: true, nativeLook: true })).toBe('Blazor Hybrid')
  expect(pickUiStack({ ...base, platforms: ['windows'], reuseBlazor: true, existingWpf: true })).toBe('Blazor Hybrid')
})
test('Blazor reuse is ignored when Linux is required', () => {
  expect(pickUiStack({ ...base, platforms: ['windows', 'linux'], reuseBlazor: true })).toBe('Avalonia')
})
test('Windows + macOS desktop falls through to Avalonia', () => {
  expect(pickUiStack({ ...base, platforms: ['windows', 'macos'] })).toBe('Avalonia')
})
```
:::

:::tip title="Rules are a conversation starter, not a verdict"
A real decision also weighs licensing, existing libraries (charting, PDF, grids), designer tooling,
hiring and the vendor's track record. Write the rules down anyway: an explicit table makes the team
argue about *requirements* instead of favourite frameworks.
:::

## What you'll meet in company codebases

Most professional .NET desktop work is **maintaining and extending** an app that's 5–15 years old.
The typical one looks like this:

- **WPF + MVVM**, often still on .NET Framework 4.x, sometimes already moved to modern .NET.
- **An MVVM framework** that wires Views to ViewModels:
  - **Prism**: regions (named placeholders a module fills with views), modules, `DelegateCommand`,
    an `EventAggregator` for loosely coupled messages, and navigation. Very common in big enterprise
    apps. Newer versions use a commercial license, so check before you add it to a new project.
  - **Caliburn.Micro**: *convention-based*. A button named `Save` is automatically bound to a
    `Save()` method on the ViewModel, and `CanSave` controls whether it's enabled. That's magical
    until you rename something.
  - **MVVM Light**: deprecated. Its spiritual successor is **CommunityToolkit.Mvvm**, which this
    region uses (`[ObservableProperty]`, `[RelayCommand]`, source generators).
  - **ReactiveUI**: an Rx-based (observable streams) style, popular with Avalonia.
- **Third-party control suites** (Telerik, DevExpress, Syncfusion, Infragistics) for data grids,
  charts and docking. These are often the real reason a migration is hard.
- **Code-behind leftovers**: logic in `MainWindow.xaml.cs` from before the team adopted MVVM.

Caliburn.Micro's convention in one tiny example:

```xml
<!-- No Command binding at all: the name does the wiring -->
<Button x:Name="AddQuest" Content="Add quest"/>
```

```csharp
public class QuestListViewModel : Screen   // Screen = Caliburn's ViewModel base class
{
    private string _newQuestTitle = "";
    public string NewQuestTitle
    {
        get => _newQuestTitle;
        set
        {
            _newQuestTitle = value;
            NotifyOfPropertyChange();                    // tell the UI NewQuestTitle changed
            NotifyOfPropertyChange(nameof(CanAddQuest)); // ...and re-check the guard
        }
    }

    public BindableCollection<string> Quests { get; } = new();

    // "Can" + method name: Caliburn uses this to enable/disable the AddQuest button
    public bool CanAddQuest => !string.IsNullOrWhiteSpace(NewQuestTitle);
    public void AddQuest() => Quests.Add(NewQuestTitle);
}
```

:::job title="Day one on a WPF team"
Expect a large solution with a `Shell` window, Prism modules or Caliburn screens, a commercial grid
and a few custom controls nobody fully understands. Your first tickets will be "add a column",
"validate this field", "this dialog freezes". To deliver them you need **binding, commands,
converters and validation**, the topics of **Data Binding & MVVM** and **Collections, Validation &
Async UI** later in this region. Before you change anything, find
how the existing app wires a View to its ViewModel (convention, `DataContext` in XAML, or a
ViewModel locator) and copy that pattern.
:::

:::quiz id=dsk-02-q6 xp=10
In a Caliburn.Micro app you find `<Button x:Name="Export"/>` with no `Command` binding. Clicking it
calls `Export()` on the ViewModel, and it's greyed out sometimes. What controls the greying out?
- [ ] A `Visibility` converter in the XAML
- [x] A `CanExport` property (or method) on the ViewModel, found by naming convention
- [ ] WPF disables any button whose name starts with a capital letter
- [ ] The `Export` method throwing an exception
> Caliburn.Micro is convention-based: `x:Name="Export"` binds to the `Export()` action, and a
> member named `CanExport` (raising change notification) controls `IsEnabled`. That's convenient,
> but renaming the method silently breaks the wiring, so search for both names before refactoring.
:::

## Migration paths

| From | To | How it usually goes |
| --- | --- | --- |
| WPF on .NET Framework 4.x | **WPF on .NET 10** | Same XAML, new SDK-style project. Use Microsoft's upgrade tooling, fix packages without modern .NET versions, and test. Most common, lowest risk |
| WinForms on .NET Framework | **WinForms on .NET 10**, later WPF/Blazor screen by screen | Upgrade first; host new WPF or Blazor (`BlazorWebView`) views inside the old app |
| Xamarin.Forms | **.NET MAUI** | New single project, renderers → handlers, namespace changes (`Xamarin.Forms` → `Microsoft.Maui.Controls`) |
| UWP | **WinUI 3 / Windows App SDK** | Similar XAML, namespace changes (`Windows.UI.Xaml` → `Microsoft.UI.Xaml`), app lifecycle and windowing differ |
| WPF (needs macOS/Linux) | **Avalonia** (or Avalonia XPF) | Port the XAML (very similar dialect). ViewModels written as plain C# move almost unchanged |

The theme across the whole table is that **ViewModels are portable and Views are not.** A
ViewModel that only uses `INotifyPropertyChanged` and `ICommand` (both in plain .NET) works in WPF,
WinUI, MAUI, Avalonia and Uno. Code-behind that pokes at controls has to be rewritten. That's the
strongest practical argument for MVVM.

:::pro title="Strangler migrations, not big-bang rewrites"
Senior teams rarely rewrite a desktop app in one go. They first move it to modern .NET without
changing the UI, then pull logic out of code-behind into ViewModels and services (with unit tests),
and only then swap the View layer, one screen or module at a time. Each step ships. A big-bang
rewrite tends to spend two years reaching feature parity with an app that kept changing.
:::

:::quiz id=dsk-02-q7 xp=10
You must port a WPF app to macOS. Which parts are most likely to move to Avalonia with little or no
change?
- [ ] The XAML files, unchanged: Avalonia reads `.xaml` files from WPF directly
- [x] ViewModels and services that only use `INotifyPropertyChanged`, `ICommand` and plain C#
- [ ] Code-behind event handlers that reach into controls by name
- [ ] Third-party WPF control-suite grids
> Plain-C# ViewModels don't depend on any UI framework, so they port almost as-is. The XAML is
> *similar* but not identical (different namespaces, styling system and some controls), so it needs
> real porting work. Code-behind and WPF-only control suites are tied to WPF and have to be rewritten
> or replaced, unless you buy Avalonia XPF.
:::

## Lab: see the landscape on your own machine

:::lab id=dsk-02-lab1 xp=30
title: Templates, workloads and a Windows-only wall
You'll see with your own eyes which frameworks your SDK knows, why WPF is Windows-only, and that
Avalonia builds anywhere. Requires the **.NET 10 SDK** (`dotnet --version` prints `10.0.x`). Works
on Windows, macOS and Linux.

**1. Which UI templates ship with the SDK?**

```bash
mkdir landscape && cd landscape
dotnet new list wpf
dotnet new list winforms
```

Expected (abridged): templates such as `wpf`, `wpflib`, `wpfusercontrollib`, `winforms`,
`winformslib`. They're installed on every OS, even Linux.

**2. Create a WPF app and try to build it.**

```bash
dotnet new wpf -o WpfPeek
cd WpfPeek
dotnet build
```

- On **Windows**: `Build succeeded.` Run it with `dotnet run` and you get an empty window.
- On **macOS/Linux**: `dotnet new` already prints `Post action failed. Manual instructions: Run
  'dotnet restore'` (its automatic restore hit the same wall), and the build fails with

```text
error NETSDK1100: To build a project targeting Windows on this operating system, set the EnableWindowsTargeting property to true.
```

Open `WpfPeek.csproj` and look at `<TargetFramework>net10.0-windows</TargetFramework>` and
`<UseWPF>true</UseWPF>`. The `-windows` suffix is the Windows-only wall. On macOS/Linux you can
*compile* with `dotnet build -p:EnableWindowsTargeting=true` (handy on CI), but the app can never
run there.

**3. Install the Avalonia templates and build an Avalonia app.**

```bash
cd ..
dotnet new install Avalonia.Templates
dotnet new list avalonia
dotnet new avalonia.app -o AvaPeek
cd AvaPeek
dotnet build
dotnet run
```

Expected: the template list includes `avalonia.app`, `avalonia.mvvm` and `avalonia.xplat` (plus
item templates such as `avalonia.window`). The app template targets `net10.0` by default (`-f`
lets you pick another) and references the latest stable Avalonia package (12.x in late 2026). The
build ends with `Build succeeded.` and `dotnet run` opens a window that says **Welcome to
Avalonia!** on Windows, macOS *and* Linux. Note the plain `<TargetFramework>net10.0</TargetFramework>`
in `AvaPeek.csproj`: no `-windows` suffix.

**4. Look at the MAUI workload (don't install it yet).**

```bash
dotnet workload search maui
```

Expected: the list differs per OS. On Windows/macOS you see `maui`, `maui-android`, `maui-ios`,
`maui-maccatalyst` and (Windows) `maui-windows`. On Linux you only see entries like `maui-android`,
`maui-tizen` and `maui-windows`, with no `maui`, iOS or Mac entry, and building MAUI apps on
Linux isn't supported. **.NET MAUI Fundamentals** installs the workload on
Windows/macOS.

**5. Clean up.**

```bash
cd ../..
rm -rf landscape
```

(On Windows PowerShell: `Remove-Item -Recurse -Force landscape`.)

- [ ] `dotnet new list wpf` showed the WPF templates
- [ ] I saw `WpfPeek.csproj` targets `net10.0-windows` (and saw the NETSDK1100 error if I'm on macOS/Linux, or the empty window on Windows)
- [ ] `dotnet new avalonia.app` built and `dotnet run` showed "Welcome to Avalonia!"
- [ ] I ran `dotnet workload search maui` and know which MAUI targets my OS can build
- [ ] I deleted the `landscape` folder
:::

:::cards id=dsk-02-cards1 xp=15 title=".NET UI landscape"
Q: Which .NET UI frameworks are Windows-only?
A: WinForms, WPF, UWP and WinUI 3 (Windows App SDK).
Q: What replaced Xamarin.Forms, and when did Xamarin support end?
A: .NET MAUI. Xamarin support ended in May 2024.
Q: Which platforms does .NET MAUI target?
A: Android, iOS, macOS (Mac Catalyst) and Windows (via WinUI 3). Not Linux.
Q: Native controls vs self-drawn: one framework of each?
A: Native: MAUI, WinForms (the OS draws the widget). Self-drawn: WPF, Avalonia (the framework paints every pixel, Avalonia with Skia).
Q: What is Blazor Hybrid?
A: Razor components hosted in a BlazorWebView inside a MAUI, WPF or WinForms app. HTML UI, C# running natively.
Q: What does Uno Platform implement on every platform?
A: The WinUI 3 API (same XAML and control names), on iOS, Android, macOS, Linux and WebAssembly.
Q: What is Prism?
A: An MVVM framework common in enterprise WPF: regions, modules, DelegateCommand, EventAggregator, navigation.
Q: What is Caliburn.Micro known for?
A: Convention-based binding: x:Name="Save" calls Save(), CanSave controls IsEnabled.
Q: Which part of an app ports between XAML frameworks most easily?
A: Plain-C# ViewModels and services (INotifyPropertyChanged, ICommand). Views and code-behind must be rewritten.
Q: Requirements include Linux desktop. Which frameworks remain?
A: Avalonia and Uno Platform.
:::

## Recap

- Each framework answered the platforms of its era: **WinForms** (2002) and **WPF** (2006) for
  Windows, **UWP → WinUI 3** for modern Windows, **Xamarin → MAUI** for mobile, **Avalonia** and
  **Uno** for everywhere including Linux and the browser, and **Blazor Hybrid** for reusing web
  components.
- There are three rendering models: **native controls** (MAUI, WinForms), **self-drawn** (WPF,
  WinUI, Avalonia, Uno) and **web view** (Blazor Hybrid). They explain most of the trade-offs.
- Choose from requirements: existing app → keep and modernise; Windows-only new → WinUI 3; Linux →
  Avalonia/Uno; native mobile → MAUI; Blazor team → Blazor Hybrid.
- In real jobs you'll mostly meet **WPF + MVVM**, often with **Prism** or **Caliburn.Micro** and a
  commercial control suite.
- **ViewModels port, Views don't.** Clean MVVM is your migration insurance.
- This region builds **QuestBoard** in Avalonia with CommunityToolkit.Mvvm and compiled bindings,
  adds MAUI for mobile, and ends with the BranchStory reader boss.
