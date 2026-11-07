---
id: dsk-07
title: Navigation, DI & Services
level: advanced
minutes: 120
xp: 150
summary: Wire a desktop app like a real product — a DI container and generic host, view-model-first navigation with guards, MVVM-friendly dialogs, a typed HttpClient for your API, configuration, secrets and logging.
---

## Why architecture suddenly matters

So far QuestBoard has been one window with one view model. That is fine for learning bindings, but
every real desktop app quickly grows the same needs:

- **Several screens** — a list, an editor, settings — and a way to move between them (and back).
- **Shared services** — one API client, one settings store, one logger — used by many view models.
- **Dialogs** — "Discard your changes?" — without the view model creating windows.
- **A server** — the data lives behind an ASP.NET Core API, not in memory.
- **Configuration and logs** — the API URL differs between your laptop and production, and when a
  user reports "it doesn't load", you want a log file, not a guess.

If each view model does `new QuestApiClient(new HttpClient())` and `new Window().ShowDialog()`,
you get code that can't be unit-tested, can't be reconfigured, and leaks sockets. This lesson
replaces that with the same building blocks ASP.NET Core uses — so everything you learned in the
Backend region transfers directly.

| Term | Plain-English meaning |
|---|---|
| **Dependency** | Something a class needs to do its job (an API client, a logger). |
| **Dependency injection (DI)** | The class *receives* its dependencies (usually via the constructor) instead of creating them. |
| **DI container / service provider** | An object that knows how to build every service and hands them out. In .NET: `IServiceProvider` from `Microsoft.Extensions.DependencyInjection`. |
| **Registration** | Telling the container "when someone asks for `IQuestApi`, build a `QuestApiClient`". |
| **Lifetime** | How long a built instance lives: *singleton*, *transient* or *scoped*. |
| **Generic host** | `Microsoft.Extensions.Hosting`: one object that bundles DI + configuration + logging (+ background services) and starts/stops them. |
| **Composition root** | The single place where all registrations happen — the only code that knows which concrete class implements which interface. |
| **Navigation service** | A service that owns "which page is showing" and a back stack. |
| **Typed client** | A small class wrapping `HttpClient` with methods like `GetQuestsAsync()`. |

## Dependency injection in 5 minutes

Here is a view model **without** DI. It works, but look at what it decides on its own:

```csharp
public class QuestListViewModel
{
    // Hard-coded URL, a new HttpClient per view model, no way to swap in a fake for tests.
    private readonly QuestApiClient _api = new(new HttpClient { BaseAddress = new Uri("http://localhost:5180/") });
}
```

And **with** DI. The view model only states what it needs:

```csharp
public class QuestListViewModel(IQuestApi api)   // C# 12+ primary constructor
{
    // 'api' is whatever the container (or a test) passes in.
}
```

The *how* moves to the composition root:

```csharp
var services = new ServiceCollection();
services.AddSingleton<IQuestApi, QuestApiClient>();   // "IQuestApi → QuestApiClient, one for the app"
services.AddTransient<QuestListViewModel>();          // "a fresh view model each time"
IServiceProvider provider = services.BuildServiceProvider();

var vm = provider.GetRequiredService<QuestListViewModel>();  // container builds QuestApiClient first, then the VM
```

`GetRequiredService<T>()` looks at `T`'s constructor, resolves each parameter (recursively), and
calls it. If something is not registered it throws — which is exactly what you want to find in a
test rather than in front of a user.

### Lifetimes on the desktop

| Lifetime | Registration | One instance per… | Desktop use |
|---|---|---|---|
| Singleton | `AddSingleton<T>()` | whole app | API client, navigation service, dialog service, settings, the shell view model |
| Transient | `AddTransient<T>()` | every request — each `GetRequiredService` call *and* each constructor it is injected into | page view models (fresh editor = empty form) |
| Scoped | `AddScoped<T>()` | each `IServiceScope` you create | rare on desktop; ASP.NET creates one scope per request, a desktop app has no requests. Use it for "one `DbContext` per window/unit of work" with `CreateScope()`. |

:::warn title="Captive dependencies"
A singleton that takes a transient in its constructor **captures** that instance forever — it is
created once and never refreshed. Register page view models as transient and never inject them into
singletons; ask the navigation service for them instead. (In the `Development` environment the
host turns on `ValidateScopes`, which catches the scoped version of this mistake at startup.)
:::

:::quiz id=dsk-07-q1 xp=10
QuestBoard registers `QuestEditorViewModel` as a **singleton**. A user types half a quest, presses
Cancel, then clicks **New quest** again. What do they see?
- [ ] An empty form, because the editor view is recreated
- [x] The half-typed text, because the same view model instance is shown again
- [ ] An exception: singletons can't be navigated to
- [ ] An empty form, because bindings reset view model properties on load
> A singleton is built once and reused, so its `Title` property still holds the old text. The view
> is recreated by the ViewLocator, but it binds to the same old view model. Page view models are
> normally **transient** so every navigation starts fresh; long-lived things (API client, navigation,
> dialogs) are singletons.
:::

:::challenge id=dsk-07-c1 lang=ts xp=40
title: A tiny DI container
Build the heart of `Microsoft.Extensions.DependencyInjection` in TypeScript, so lifetimes stop being
magic. `createContainer()` returns an object with:

- `addSingleton(name, factory)` — the factory runs **once**; later `resolve` calls return the same value.
- `addTransient(name, factory)` — the factory runs on **every** `resolve`.
- `resolve(name)` — builds the service. A factory receives `resolve` so it can ask for its own dependencies.
- A `resolve` that throws must leave the container usable: later `resolve` calls (including a retry
  of the same name once the missing service is registered) work normally.

Errors (exact messages):

- unknown name → `No service registered for "name"`
- a service that (directly or indirectly) needs itself → `Circular dependency: a -> b -> a`
  (the chain from the first service being resolved to the repeated one).

hint: Store registrations in a `Map<string, { lifetime, factory, instance?, built }>`.
hint: Keep an array `resolving` of names currently being built; push before calling the factory, pop in `finally`.
hint: Check the singleton cache *before* the circular check, so an already-built singleton never counts as a cycle.

```ts starter
type Resolve = (name: string) => unknown
type Factory = (resolve: Resolve) => unknown

export function createContainer() {
  const registrations = new Map<string, { lifetime: 'singleton' | 'transient'; factory: Factory }>()

  function resolve(name: string): unknown {
    // TODO: look up, respect the lifetime, detect cycles
    throw new Error('not implemented')
  }

  return {
    addSingleton(name: string, factory: Factory) { registrations.set(name, { lifetime: 'singleton', factory }) },
    addTransient(name: string, factory: Factory) { registrations.set(name, { lifetime: 'transient', factory }) },
    resolve,
  }
}
```

```ts solution
type Resolve = (name: string) => unknown
type Factory = (resolve: Resolve) => unknown
type Registration = { lifetime: 'singleton' | 'transient'; factory: Factory; built?: boolean; instance?: unknown }

export function createContainer() {
  const registrations = new Map<string, Registration>()
  const resolving: string[] = []

  function resolve(name: string): unknown {
    const reg = registrations.get(name)
    if (!reg) throw new Error(`No service registered for "${name}"`)
    if (reg.lifetime === 'singleton' && reg.built) return reg.instance
    if (resolving.includes(name)) {
      const start = resolving.indexOf(name)
      throw new Error(`Circular dependency: ${[...resolving.slice(start), name].join(' -> ')}`)
    }
    resolving.push(name)
    try {
      const value = reg.factory(resolve)
      if (reg.lifetime === 'singleton') { reg.instance = value; reg.built = true }
      return value
    } finally {
      resolving.pop()
    }
  }

  return {
    addSingleton(name: string, factory: Factory) { registrations.set(name, { lifetime: 'singleton', factory }) },
    addTransient(name: string, factory: Factory) { registrations.set(name, { lifetime: 'transient', factory }) },
    resolve,
  }
}
```

```ts tests
test('transient: a new object every time', () => {
  const c = createContainer()
  c.addTransient('editor', () => ({ title: '' }))
  expect(c.resolve('editor')).not.toBe(c.resolve('editor'))
})
test('singleton: the factory runs once', () => {
  const c = createContainer()
  const factory = fn(() => ({ quests: [] }))
  c.addSingleton('api', factory)
  expect(c.resolve('api')).toBe(c.resolve('api'))
  expect(factory).toHaveBeenCalledTimes(1)
})
test('factories resolve their own dependencies', () => {
  const c = createContainer()
  c.addSingleton('api', () => ({ name: 'QuestApiClient' }))
  c.addTransient('listVm', (r) => ({ api: r('api') }))
  const a = c.resolve('listVm') as { api: unknown }
  const b = c.resolve('listVm') as { api: unknown }
  expect(a).not.toBe(b)
  expect(a.api).toBe(b.api)
})
test('captive dependency: a singleton keeps its first transient forever', () => {
  const c = createContainer()
  c.addTransient('clock', () => ({}))
  c.addSingleton('shell', (r) => ({ clock: r('clock') }))
  const shell = c.resolve('shell') as { clock: unknown }
  expect((c.resolve('shell') as { clock: unknown }).clock).toBe(shell.clock)
  expect(c.resolve('clock')).not.toBe(shell.clock)
})
test('unknown service throws a helpful message', () => {
  const c = createContainer()
  expect(() => c.resolve('logger')).toThrow('No service registered for "logger"')
})
test('cycles are reported with the chain', () => {
  const c = createContainer()
  c.addTransient('a', (r) => r('b'))
  c.addTransient('b', (r) => r('a'))
  expect(() => c.resolve('a')).toThrow('Circular dependency: a -> b -> a')
})
test('a failed resolve does not poison the next one', () => {
  const c = createContainer()
  c.addTransient('a', (r) => r('missing'))
  c.addTransient('ok', () => 42)
  expect(() => c.resolve('a')).toThrow('No service registered')
  expect(c.resolve('ok')).toBe(42)
  c.addTransient('missing', () => 'now here')
  expect(c.resolve('a')).toBe('now here')
})
```
:::

## The generic host in a desktop app

ASP.NET Core's `WebApplication.CreateBuilder` is a *web* host. Its little brother
`Host.CreateApplicationBuilder` (package `Microsoft.Extensions.Hosting`) gives a desktop app the
same three things in one line:

1. **Configuration** — `appsettings.json`, `appsettings.{Environment}.json`, user secrets (in
   Development), environment variables, command-line args, layered in that order (later wins).
2. **Logging** — `ILogger<T>` with console and debug providers, levels from configuration.
3. **DI** — `builder.Services`, validated on build in Development.

```csharp
var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
{
    ContentRootPath = AppContext.BaseDirectory,   // look for appsettings.json next to the .exe
});
builder.Services.AddSingleton<INavigationService, NavigationService>();
using IHost host = builder.Build();
host.Start();                                     // starts any IHostedService (background work)
var nav = host.Services.GetRequiredService<INavigationService>();
```

**Avalonia does not create the host for you** (MAUI does — see below). You build it in
`App.OnFrameworkInitializationCompleted`, the moment Avalonia is ready, resolve the main window's
view model from it, and stop it when the app exits:

```csharp
public override void OnFrameworkInitializationCompleted()
{
    _host = AppHost.Build();
    _host.Start();
    if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
    {
        desktop.MainWindow = new MainWindow { DataContext = _host.Services.GetRequiredService<MainWindowViewModel>() };
        desktop.Exit += (_, _) => _host.Dispose();
    }
    base.OnFrameworkInitializationCompleted();
}
```

:::tip title="Why ContentRootPath matters"
By default the content root is the **current working directory**. `dotnet run` happens to start in
the project folder, so `appsettings.json` is found — but a user double-clicking the `.exe` from a
shortcut starts somewhere else, and your settings silently vanish. Desktop apps set
`ContentRootPath = AppContext.BaseDirectory` and copy `appsettings*.json` to the output folder.
:::

:::warn title="Avoid the service locator"
CommunityToolkit.Mvvm ships `Ioc.Default`, a global container you can call from anywhere:
`Ioc.Default.GetService<IQuestApi>()`. It is handy for XAML-instantiated objects, but a class that
reaches into a global container hides its dependencies and is hard to test. Prefer constructor
injection; call the container only in the composition root and in the navigation service.
:::

:::quiz id=dsk-07-q2 xp=10
Where should `services.AddSingleton<IQuestApi, QuestApiClient>()` live in QuestBoard?
- [ ] In `QuestListViewModel`'s constructor, because that is the first class that uses the API
- [ ] In `MainWindow.axaml.cs`, because the window is created first
- [x] In one composition root (QuestBoard's `AppHost.Build`), called from `App.OnFrameworkInitializationCompleted`
- [ ] In `appsettings.json`, under a `Services` section
> Registrations belong in **one** composition root that runs once at startup. View models and views
> only *receive* services; if they registered or created them, you'd be back to hidden, untestable
> dependencies. Configuration files hold values (URLs, timeouts), not type mappings.
:::

## View-model-first navigation

There are two ways to think about "go to the editor screen":

- **View-first:** the code creates a view (`new QuestEditorView()`), and the view creates or finds
  its view model. Simple, but now navigation code lives in views and is hard to test.
- **View-model-first:** the code asks for a *view model* (`NavigateTo<QuestEditorViewModel>()`), and
  a **view locator** (a data template) picks the matching view. Navigation is plain C# with no UI
  types — you can unit-test it.

Avalonia's MVVM template already contains the second half: `ViewLocator` is an `IDataTemplate` that
turns `QuestBoard.Desktop.ViewModels.QuestEditorViewModel` into
`QuestBoard.Desktop.Views.QuestEditorView` by replacing "ViewModel" with "View" in the type name.
So the shell window only needs a `ContentControl` bound to the current page:

```xml
<ContentControl Content="{Binding CurrentPage}" />   <!-- CurrentPage is a ViewModelBase -->
```

When `CurrentPage` changes, Avalonia looks for a data template for that object, finds the
`ViewLocator`, builds the view, and sets the view model as its `DataContext`. The **navigation
service** owns `CurrentPage` and the back stack:

```csharp
public interface INavigationService
{
    ViewModelBase? Current { get; }
    bool CanGoBack { get; }
    event EventHandler? Navigated;
    Task<bool> NavigateToAsync<TViewModel>(Action<TViewModel>? init = null) where TViewModel : ViewModelBase;
    Task<bool> GoBackAsync();
}
```

- `NavigateToAsync<T>` resolves `T` from DI (so pages get their dependencies injected), runs the
  optional `init` callback to pass parameters (`vm => vm.QuestId = 3`), pushes the old page onto the
  **back stack**, and raises `Navigated`.
- `GoBackAsync` pops the previous page — the *same instance*, so its scroll position and data
  survive.
- A **navigation guard** is a page that can say "not yet": if the current page implements
  `IConfirmNavigation`, the service awaits `CanLeaveAsync()` first. That is how "You have unsaved
  changes" works without the editor knowing anything about navigation.
- A page that must **load data each time it is shown** implements `INavigationAware`; the service
  calls its `OnNavigatedToAsync()` right after the page becomes current (the lab's quest list uses
  it to fetch from the API).

The shell view model listens to `Navigated`, copies `Current` into its `CurrentPage` property, and
refreshes the Back button's `CanExecute`.

:::info title="Other navigation styles you'll meet"
**MAUI Shell** uses URI routes: `Routing.RegisterRoute("editor", typeof(QuestEditorPage))` then
`await Shell.Current.GoToAsync("editor?id=3")`, with `".."` meaning back. **WPF / WinUI** apps often
use a `Frame` with `Navigate(typeof(Page))` or a framework (Prism regions). **ReactiveUI** has
`RoutingState` with `Router.Navigate.Execute(vm)`. The ideas — a stack, parameters, guards — are
the same; only the API differs.
:::

:::quiz id=dsk-07-q3 xp=10
In view-model-first navigation, which piece knows that `QuestEditorViewModel` is displayed by
`QuestEditorView`?
- [ ] The navigation service, through a `switch` on the view model type
- [ ] `QuestEditorViewModel`, which creates its own view in the constructor
- [x] The view locator / data templates — the navigation service only deals with view models
- [ ] `App.axaml`'s `RequestedThemeVariant`
> The point of view-model-first is that navigation logic never touches UI types, so it can be
> tested with plain unit tests. The mapping from view model to view lives in the `ViewLocator`
> (registered in `App.axaml` under `Application.DataTemplates`) or in explicit `DataTemplate`s.
:::

:::challenge id=dsk-07-c2 lang=ts xp=50
title: Navigation stack with guards
Implement the navigation stack that powers QuestBoard's Back button. Pages are just strings here
(`'list'`, `'editor'`…). `new NavigationStack(root)` starts on `root`.

- `current` — the page on top. `canGoBack` — true when there is something under it. `depth` — number of entries.
- `push(page)` — go to a new page. Pushing the page that is **already current** does nothing and returns `false`.
- `replace(page)` — swap the current page without growing the stack (e.g. login → home: Back must not return to login).
- `back()` — return to the previous page. `false` at the root.
- `popToRoot()` — jump straight back to the first page. `false` if already at the root.
- `addGuard(fn)` — `fn(from, to)` is called before **every** change; if any guard returns `false`,
  the change is cancelled and the method returns `false`. `addGuard` returns a function that removes the guard.
- `history()` — a **copy** of the stack, bottom first.

All change methods return `true` when the change happened.

hint: Keep a `string[]`; `current` is the last element.
hint: Write one private `allowed(to)` helper: `this.guards.every((g) => g(this.current, to))`.
hint: For `back`, the target is `stack[stack.length - 2]`; for `popToRoot` it's `stack[0]`.

```ts starter
type Guard = (from: string, to: string) => boolean

export class NavigationStack {
  private stack: string[]

  constructor(root: string) {
    this.stack = [root]
  }

  get current(): string { return this.stack[0] }
  get canGoBack(): boolean { return false }
  get depth(): number { return 1 }

  addGuard(guard: Guard): () => void {
    return () => {}
  }

  push(page: string): boolean { return false }
  replace(page: string): boolean { return false }
  back(): boolean { return false }
  popToRoot(): boolean { return false }
  history(): string[] { return this.stack }
}
```

```ts solution
type Guard = (from: string, to: string) => boolean

export class NavigationStack {
  private stack: string[]
  private guards: Guard[] = []

  constructor(root: string) {
    this.stack = [root]
  }

  get current(): string { return this.stack[this.stack.length - 1] }
  get canGoBack(): boolean { return this.stack.length > 1 }
  get depth(): number { return this.stack.length }

  addGuard(guard: Guard): () => void {
    this.guards.push(guard)
    return () => { this.guards = this.guards.filter((g) => g !== guard) }
  }

  private allowed(to: string): boolean {
    return this.guards.every((g) => g(this.current, to))
  }

  push(page: string): boolean {
    if (page === this.current || !this.allowed(page)) return false
    this.stack.push(page)
    return true
  }

  replace(page: string): boolean {
    if (!this.allowed(page)) return false
    this.stack[this.stack.length - 1] = page
    return true
  }

  back(): boolean {
    if (!this.canGoBack) return false
    if (!this.allowed(this.stack[this.stack.length - 2])) return false
    this.stack.pop()
    return true
  }

  popToRoot(): boolean {
    if (!this.canGoBack || !this.allowed(this.stack[0])) return false
    this.stack.length = 1
    return true
  }

  history(): string[] { return [...this.stack] }
}
```

```ts tests
test('starts on the root page', () => {
  const nav = new NavigationStack('list')
  expect(nav.current).toBe('list')
  expect(nav.canGoBack).toBe(false)
  expect(nav.depth).toBe(1)
})
test('push then back', () => {
  const nav = new NavigationStack('list')
  expect(nav.push('editor')).toBe(true)
  expect(nav.current).toBe('editor')
  expect(nav.canGoBack).toBe(true)
  expect(nav.back()).toBe(true)
  expect(nav.current).toBe('list')
})
test('back at the root does nothing', () => {
  const nav = new NavigationStack('list')
  expect(nav.back()).toBe(false)
  expect(nav.current).toBe('list')
})
test('pushing the current page again is ignored (double-click on a button)', () => {
  const nav = new NavigationStack('list')
  nav.push('editor')
  expect(nav.push('editor')).toBe(false)
  expect(nav.depth).toBe(2)
})
test('replace swaps the top without growing the stack', () => {
  const nav = new NavigationStack('login')
  expect(nav.replace('list')).toBe(true)
  expect(nav.depth).toBe(1)
  expect(nav.canGoBack).toBe(false)
  nav.push('editor')
  nav.replace('detail')
  expect(nav.history()).toEqual(['list', 'detail'])
})
test('popToRoot jumps to the first page', () => {
  const nav = new NavigationStack('list')
  nav.push('detail')
  nav.push('editor')
  expect(nav.popToRoot()).toBe(true)
  expect(nav.history()).toEqual(['list'])
  expect(nav.popToRoot()).toBe(false)
})
test('a guard receives from/to and can cancel back', () => {
  const nav = new NavigationStack('list')
  nav.push('editor')
  const guard = fn((from: string, to: string) => !(from === 'editor' && to === 'list'))
  nav.addGuard(guard)
  expect(nav.back()).toBe(false)
  expect(guard).toHaveBeenCalledWith('editor', 'list')
  expect(nav.current).toBe('editor')
})
test('guards apply to push, replace and popToRoot too', () => {
  const nav = new NavigationStack('list')
  nav.push('detail')
  nav.addGuard(() => false)
  expect(nav.push('editor')).toBe(false)
  expect(nav.replace('settings')).toBe(false)
  expect(nav.popToRoot()).toBe(false)
  expect(nav.history()).toEqual(['list', 'detail'])
})
test('removing a guard lets navigation through again', () => {
  const nav = new NavigationStack('list')
  nav.push('editor')
  const remove = nav.addGuard(() => false)
  expect(nav.back()).toBe(false)
  remove()
  expect(nav.back()).toBe(true)
})
test('history() is a copy', () => {
  const nav = new NavigationStack('list')
  nav.history().push('hacked')
  expect(nav.depth).toBe(1)
  expect(nav.current).toBe('list')
})
```
:::

## Dialogs and message boxes, the MVVM way

A view model must not create windows. Three reasons:

1. **Tests hang or crash.** A unit test has no UI thread and no main window; `ShowDialog` either
   throws or waits forever for a click.
2. **Platforms differ.** On desktop a dialog is a separate window; on Avalonia mobile/browser
   (single-view lifetime) and in MAUI it's an overlay or a platform alert.
3. **Coupling.** A view model that references `Window` drags the UI framework into your logic layer.

The fix is the same pattern as everywhere in this lesson: **an interface the view model asks, and an
implementation the composition root provides.**

```csharp
public interface IDialogService
{
    Task<bool> ConfirmAsync(string title, string message);
    Task AlertAsync(string title, string message);
}

// In a view model:
if (!await dialogs.ConfirmAsync("Complete quest", $"Mark \"{quest.Title}\" as done?"))
    return;
```

The Avalonia implementation builds a small `Window` and calls `ShowDialog<bool>(owner)`, where the
owner is the main window from `IClassicDesktopStyleApplicationLifetime`. The returned task completes
when the dialog closes; `dialog.Close(true)` sets the result, and closing with the X returns
`default(bool)` = `false`. In tests you register a `FakeDialogs` that answers instantly.

Avalonia has no built-in message box. Teams either write a service like the one in the lab, or
use a community package such as *MessageBox.Avalonia* or *DialogHost.Avalonia* (overlay dialogs
that also work in single-view apps). WPF has `MessageBox.Show`; MAUI pages have
`DisplayAlertAsync` — in every case, hide it behind `IDialogService`.

:::quiz id=dsk-07-q4 xp=10
A view model method calls `await new ConfirmWindow().ShowDialog<bool>(mainWindow)` directly. What
is the most important practical problem?
- [ ] `ShowDialog` is slower than `Show`
- [x] The view model can't be unit-tested — there is no window or UI thread in a test, and nothing to click
- [ ] Compiled bindings stop working in that view model
- [ ] It only works on Windows
> `ShowDialog` is fine on every desktop platform, but a view model that opens real windows needs a
> real UI to run. Behind an `IDialogService`, a test injects a fake that returns `true` or `false`
> instantly and can assert *which* question was asked.
:::

## Calling your API: HttpClient and typed clients

### Why not `new HttpClient()`?

`HttpClient` looks disposable-per-call, but each instance owns a connection pool. Creating and
disposing one per request leaves closed connections lingering in the operating system's `TIME_WAIT`
state for a while; make enough requests and the machine runs out of free ports
(**socket exhaustion**). Keeping one static instance forever avoids that, but its pooled
connections never notice DNS changes (the server moved to a new IP). `IHttpClientFactory` (package
`Microsoft.Extensions.Http`) solves both: it hands out cheap `HttpClient` objects that share pooled,
periodically recycled handlers.

A **typed client** is a class that takes an `HttpClient` in its constructor; the factory configures
and injects it:

```csharp
builder.Services.AddHttpClient<IQuestApi, QuestApiClient>((sp, http) =>
{
    var options = sp.GetRequiredService<IOptions<QuestApiOptions>>().Value;
    http.BaseAddress = new Uri(options.BaseUrl);            // "http://localhost:5180/"
    http.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
});

public sealed class QuestApiClient(HttpClient http) : IQuestApi
{
    public async Task<IReadOnlyList<Quest>> GetQuestsAsync(CancellationToken ct = default) =>
        await http.GetFromJsonAsync<List<Quest>>("api/quests", ct) ?? [];
}
```

- `GetFromJsonAsync`, `PostAsJsonAsync` and `ReadFromJsonAsync` (namespace `System.Net.Http.Json`)
  use **web defaults**: camelCase names and case-insensitive matching, so the API's
  `{"id":1,"title":"…"}` maps onto `record Quest(int Id, string Title, …)`.
- `EnsureSuccessStatusCode()` throws `HttpRequestException` for 4xx/5xx — catch it in the view model
  and show a friendly message. A timeout throws `TaskCanceledException`.
- Pass a `CancellationToken` so a page that is left can cancel its request.

:::warn title="The BaseAddress trailing slash"
`new Uri(new Uri("http://host/v1"), "api/quests")` is `http://host/api/quests` — the `v1` is
dropped, because without a trailing slash `v1` counts as a *file name*. Always end `BaseAddress`
with `/` and write request paths **without** a leading `/`.
:::

:::quiz id=dsk-07-q5 xp=10
`BaseAddress` is `https://api.example.com/questboard` and the client calls
`GetFromJsonAsync("api/quests")`. Which URL is requested?
- [ ] `https://api.example.com/questboard/api/quests`
- [x] `https://api.example.com/api/quests`
- [ ] `https://api.example.com/questboard/quests`
- [ ] It throws because the base address has no trailing slash
> Relative URIs are resolved like links in a web page: the last path segment without a trailing
> slash is replaced. Use `https://api.example.com/questboard/` as the base. A path that *starts*
> with `/` (`"/api/quests"`) would also drop `questboard`, because it is relative to the host root.
:::

:::quiz id=dsk-07-q6 xp=10
Why does QuestBoard use `AddHttpClient<IQuestApi, QuestApiClient>()` instead of creating
`new HttpClient()` inside every `GetQuestsAsync` call? (Select all that apply.)
- [x] Disposing a client per call can exhaust sockets under load
- [x] The factory recycles handlers, so DNS changes are eventually picked up
- [x] Base address, headers and timeout are configured once, in the composition root
- [ ] `new HttpClient()` cannot send JSON
> All three are the reasons `IHttpClientFactory` exists. `new HttpClient()` can send JSON perfectly
> well — the problems are connection lifetime and scattered configuration, not features.
:::

### Talking to the BranchStory (or any ASP.NET) API

Everything above is what the boss fight needs: a typed `IBranchStoryApi` with `GetStoriesAsync`,
`GetNodeAsync(id)`, a base URL from configuration, and a bearer token added to each request. For
tokens, add a `DelegatingHandler` — a small piece of middleware for *outgoing* requests:

```csharp
public sealed class BearerTokenHandler(ITokenStore tokens) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var token = await tokens.GetAccessTokenAsync(ct);
        if (token is not null)
            request.Headers.Authorization = new("Bearer", token);
        return await base.SendAsync(request, ct);
    }
}

// Registration: handlers are transient; the factory chains them in order.
builder.Services.AddTransient<BearerTokenHandler>();
builder.Services.AddHttpClient<IBranchStoryApi, BranchStoryApiClient>(…).AddHttpMessageHandler<BearerTokenHandler>();
```

:::pro title="Resilience in one line"
Senior teams add retries, timeouts and a circuit breaker to API clients with
`Microsoft.Extensions.Http.Resilience`: `.AddStandardResilienceHandler()` after `AddHttpClient`.
Desktop apps run on flaky Wi-Fi and laptops that wake from sleep; a single automatic retry with
back-off turns many "it didn't load" reports into nothing.

Careful with one detail: only retry **idempotent** requests — ones where sending them twice has the
same effect as sending them once (GET, PUT, DELETE). Retrying a POST can create the same quest
twice. The standard handler retries **every** method by default, so turn that off for "unsafe"
methods:

```csharp
builder.Services.AddHttpClient<IQuestApi, QuestApiClient>(/* … */)
    .AddStandardResilienceHandler(o => o.Retry.DisableForUnsafeHttpMethods()); // no retries for POST/PATCH/PUT/DELETE…
```

(Package `Microsoft.Extensions.Http.Resilience`; its version numbers follow their own cadence,
for example `10.x`.)
:::

## Configuration and secrets on the desktop

Configuration in a desktop app works like in ASP.NET Core:

```json
{ "QuestApi": { "BaseUrl": "http://localhost:5180/", "TimeoutSeconds": 10 } }
```

```csharp
public sealed class QuestApiOptions { public string BaseUrl { get; set; } = ""; public int TimeoutSeconds { get; set; } = 10; }
builder.Services.Configure<QuestApiOptions>(builder.Configuration.GetSection("QuestApi"));
// Anywhere: IOptions<QuestApiOptions> options → options.Value.BaseUrl
```

This is the **options pattern**: instead of reading raw strings with `configuration["QuestApi:BaseUrl"]`
all over the code, you bind a whole section once to a small C# class, and any class that needs it
asks for `IOptions<QuestApiOptions>` in its constructor. You get typed values (`int`, not `"10"`),
defaults in one place, and in tests you pass `Options.Create(new QuestApiOptions { … })`.

Sources are layered; a later one overrides an earlier one: `appsettings.json` →
`appsettings.Development.json` → user secrets (Development only) → environment variables →
command-line args. Environment variables use `__` for nesting: `QuestApi__BaseUrl=https://staging.example.com/`.
The environment name comes from `DOTNET_ENVIRONMENT` (default `Production`); QuestBoard sets
`Development` for Debug builds in code.

### The hard truth about secrets

**Anything you ship inside a desktop or mobile app is public.** `appsettings.json`, constants in
code, obfuscated strings — a user with a decompiler (ILSpy is free) or a text editor gets them in
minutes. So:

| Need | Do this |
|---|---|
| Development-only keys on *your* machine | **User secrets**: `dotnet user-secrets set "QuestApi:ApiKey" "…"` — stored in your user profile, outside the repo. |
| Users calling *your* API | Each user **signs in** (OpenID Connect — the standard "log in with…" protocol — using PKCE, its variant for apps that can't keep a secret, via the system browser, e.g. against Keycloak or Entra ID). The app gets a short-lived token for that user — no shared secret in the binary. |
| Storing that token | The OS credential store: Windows Credential Manager/DPAPI, macOS Keychain, Linux Secret Service. MAUI wraps these as `SecureStorage.Default.SetAsync("token", value)`. |
| Third-party API keys (payments, maps with billing) | Keep them on **your server**; the desktop app calls your API, your API calls the third party. |
| Non-secret per-user settings (theme, window size) | A JSON file under `Environment.GetFolderPath(SpecialFolder.ApplicationData)`, or MAUI `Preferences`. |

:::job title="What you'll see at work"
Day-one desktop codebases almost always have: a `Host` or `MauiProgram` composition root, an
`appsettings.json` with an environment override, a typed API client per backend, a
`DelegatingHandler` for auth, and logs written to a file under `%LOCALAPPDATA%\Company\App\logs`.
And at least once, someone will find an API key committed in `appsettings.json` — the fix is to
rotate the key and move the call server-side, not to "hide it better".
:::

:::quiz id=dsk-07-q7 xp=10
QuestBoard must call a mapping service whose API key costs money per request. Where should the key
live in production?
- [ ] In `appsettings.json`, because it isn't compiled into the code
- [ ] In user secrets, so it isn't in Git
- [ ] Base64-encoded in a constant, so users can't read it
- [x] On your own server; the desktop app calls your API (with the user's token) and the server calls the mapping service
> Files shipped with the app, constants and encodings are all readable by anyone who has the app.
> User secrets are a **development** tool on the developer's machine only — they don't exist on a
> user's PC. A billed key must stay server-side, behind your own authenticated API.
:::

:::quiz id=dsk-07-q8 xp=10
`appsettings.json` has `"QuestApi": { "BaseUrl": "http://localhost:5180/" }`. A tester starts the
app with the environment variable `QuestApi__BaseUrl=https://staging.example.com/`. Which URL does
`IOptions<QuestApiOptions>` contain?
- [x] `https://staging.example.com/` — environment variables are added after JSON files, and later sources win
- [ ] `http://localhost:5180/` — files always beat environment variables
- [ ] Neither: the double underscore is invalid, so startup fails
- [ ] Both, joined with a comma
> The host adds configuration sources in order: JSON files, then user secrets (Development), then
> environment variables, then command-line args. For the same key, the last source wins. `__` is
> the portable separator for `:` in environment variable names.
:::

## Logging that helps you later

`ILogger<T>` is injected like any other service. Two habits make logs useful:

```csharp
// Structured: {Count} and {BaseAddress} become named fields a log viewer can filter on.
log.LogInformation("Loaded {Count} quests from {BaseAddress}", quests.Count, http.BaseAddress);

// Not this: the values are baked into one string, and it's formatted even when the level is off.
log.LogInformation($"Loaded {quests.Count} quests");
```

- **Levels:** `Trace` < `Debug` < `Information` < `Warning` < `Error` < `Critical`. Set per category
  in `appsettings.json` under `Logging:LogLevel` (`"System.Net.Http.HttpClient": "Warning"` silences
  the per-request lines the HTTP factory logs).
- **Exceptions:** pass the exception object first — `log.LogWarning(ex, "Could not load quests")` —
  so the stack trace is kept.
- **Where do logs go?** The default host logs to the console and the debugger. A Windows `WinExe`
  has no console, so QuestBoard builds as `Exe` in Debug (you see a console) and `WinExe` in
  Release. For users, add a file sink (for example Serilog with `Serilog.Extensions.Hosting` +
  `Serilog.Sinks.File`) writing under `LocalApplicationData`, with rolling files.
- **Crashes:** hook `AppDomain.CurrentDomain.UnhandledException`, `TaskScheduler.UnobservedTaskException`
  and Avalonia's `Dispatcher.UIThread.UnhandledException` to log before the app dies.

:::quiz id=dsk-07-q9 xp=10
Which log call is best?
- [ ] `log.LogError("Save failed: " + ex.Message);`
- [ ] `log.LogError($"Save failed for quest {id}: {ex}");`
- [x] `log.LogError(ex, "Save failed for quest {QuestId}", id);`
- [ ] `Console.WriteLine("Save failed");`
> Passing `ex` keeps the full exception (type, stack trace, inner exceptions) as structured data,
> and the `{QuestId}` placeholder becomes a searchable field. String concatenation and
> interpolation flatten everything into text, and `Console.WriteLine` bypasses levels, categories
> and every configured sink.
:::

## The same architecture in .NET MAUI

MAUI builds the host for you: `MauiProgram.CreateMauiApp()` *is* the composition root, pages
registered in DI get their view models injected, and Shell routes replace the navigation service.
**.NET MAUI Fundamentals** covers `MauiProgram`, lifetimes and Shell navigation in detail; here is
only the part that's new in this lesson, the typed API client:

```csharp
// MauiProgram.CreateMauiApp(), next to the page and view model registrations
builder.Services.AddHttpClient<IQuestApi, QuestApiClient>(http =>
    // Android emulator: the host machine is 10.0.2.2, not localhost.
    http.BaseAddress = new Uri(DeviceInfo.Platform == DevicePlatform.Android
        ? "http://10.0.2.2:5180/" : "http://localhost:5180/"));
builder.Services.AddTransient<QuestListViewModel>();
builder.Services.AddTransient<QuestListPage>();
```

`AddHttpClient` is not part of the MAUI template: add it with `dotnet add package
Microsoft.Extensions.Http`. Dialogs come from `Page.DisplayAlertAsync` (wrap it in
`IDialogService`), secrets from `SecureStorage`, settings from `Preferences` (both in **MAUI Platform
Features & Offline Data**).

:::warn title="MAUI on Linux, and HTTP on phones"
The MAUI workload (`dotnet workload install maui`) **cannot build MAUI apps on Linux** — use Windows
(Android + Windows targets) or macOS (iOS, Mac Catalyst, Android). The MAUI code above is verified by
the learner on Windows/macOS; the lab below uses Avalonia, which builds everywhere. Also: Android
and iOS block plain `http://` by default. For local development either use HTTPS or allow cleartext
for your dev host (Android network security config / iOS `NSAppTransportSecurity`) — never ship that
exception to production.
:::

:::quiz id=dsk-07-q10 xp=10
Your MAUI app runs in the Android emulator and calls `http://localhost:5180/api/quests`, where the
minimal API is running on your PC. The request fails. Why?
- [ ] MAUI can't call minimal APIs, only controllers
- [x] Inside the emulator, `localhost` is the emulator itself; the host PC is `10.0.2.2` (and cleartext HTTP must be allowed for dev)
- [ ] `HttpClient` is not available on Android
- [ ] The API must be published to Azure first
> The emulator is a separate (virtual) device with its own network stack, so `localhost` points at
> it, not your PC. Android's emulator maps `10.0.2.2` to the host's loopback. Physical devices need
> your PC's LAN IP and an API listening on that interface.
:::

:::lab id=dsk-07-lab1 xp=100
title: QuestBoard talks to a minimal API
You'll build three projects in one solution:

- **QuestBoard.Api** — a tiny ASP.NET Core 10 minimal API with an in-memory quest list, protected by an `X-Api-Key` header.
- **QuestBoard.Desktop** — Avalonia 12 + CommunityToolkit.Mvvm, wired with the generic host: DI,
  configuration + user secrets, logging, a typed `HttpClient`, view-model-first navigation with a guard, and a dialog service.
- **QuestBoard.Desktop.Tests** — xUnit tests for navigation, the API client, the editor and the DI graph.

Works on Windows, macOS and Linux with the .NET 10 SDK. (Already have QuestBoard from earlier
lessons? Build this in a fresh folder anyway, then port the pieces over.)

### 1. Create the solution

```bash
dotnet new install Avalonia.Templates
mkdir questboard-net && cd questboard-net
dotnet new sln -n QuestBoard
dotnet new web -o QuestBoard.Api
dotnet new avalonia.mvvm -o QuestBoard.Desktop
dotnet new xunit -o QuestBoard.Desktop.Tests
dotnet sln add QuestBoard.Api QuestBoard.Desktop QuestBoard.Desktop.Tests
dotnet add QuestBoard.Desktop.Tests reference QuestBoard.Desktop
dotnet add QuestBoard.Desktop package Microsoft.Extensions.Hosting
dotnet add QuestBoard.Desktop package Microsoft.Extensions.Http
```

Delete the template files you'll replace (macOS/Linux shown; on Windows delete them in Explorer or with `del`):

```bash
rm QuestBoard.Desktop/ViewModels/MainViewModel.cs QuestBoard.Desktop.Tests/UnitTest1.cs
mkdir -p QuestBoard.Desktop/Services QuestBoard.Desktop/Models
```

:::tip
The project file in step 3 pins Avalonia 12.1.5, the version every QuestBoard lab uses. `dotnet add package` picks the newest **stable** 10.0.x patch of the Microsoft.Extensions
packages — a higher patch number than shown below is fine. (If .NET 11 is out by the time you read
this, `dotnet add package` may pick 11.x; add `--version 10.0.14` to stay on the .NET 10 line.)
:::

:::warn title="Versions move — check the docs if something differs"
This lab was built and tested with the .NET 10 SDK, Avalonia 12.1.5, CommunityToolkit.Mvvm 8.4.2
and Microsoft.Extensions.* 10.0.14 (8 tests passing, app listing quests from the API). Template
output and package versions change over time; if a file the lab tells you to replace or delete
looks different, compare with the Avalonia docs (docs.avaloniaui.net — "Getting started" and
"View locator") and Microsoft Learn's ".NET Generic Host" and "IHttpClientFactory" pages.
:::

### 2. The API

`QuestBoard.Api/Program.cs`:

```csharp
using System.Collections.Concurrent;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// The key the desktop app must send. Dev value lives in appsettings.Development.json.
var apiKey = app.Configuration["ApiKey"]
    ?? throw new InvalidOperationException("Configure ApiKey (appsettings.Development.json).");

// In-memory store: fine for a lab, gone when the process stops.
var quests = new ConcurrentDictionary<int, Quest>();
var nextId = 0;
foreach (var (title, xp) in new[] { ("Install the .NET 10 SDK", 10), ("Build QuestBoard", 50), ("Defeat the BranchStory boss", 200) })
{
    var id = Interlocked.Increment(ref nextId);
    quests[id] = new Quest(id, title, xp, false);
}

// Every /api route requires the X-Api-Key header.
var api = app.MapGroup("/api").AddEndpointFilter(async (ctx, next) =>
    ctx.HttpContext.Request.Headers["X-Api-Key"] == apiKey
        ? await next(ctx)
        : Results.Unauthorized());

api.MapGet("/quests", () => quests.Values.OrderBy(q => q.Id));

api.MapPost("/quests", (NewQuest input) =>
{
    if (string.IsNullOrWhiteSpace(input.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });
    var id = Interlocked.Increment(ref nextId);
    var quest = new Quest(id, input.Title.Trim(), input.Xp, false);
    quests[id] = quest;
    return Results.Created($"/api/quests/{id}", quest);
});

api.MapPost("/quests/{id:int}/complete", (int id) =>
    quests.TryGetValue(id, out var q)
        ? Results.Ok(quests[id] = q with { Done = true })
        : Results.NotFound());

app.Run();

record Quest(int Id, string Title, int Xp, bool Done);
record NewQuest(string Title, int Xp);
```

`QuestBoard.Api/appsettings.Development.json` (a **dev-only** key — fine in a file that never ships):

```json
{
  "ApiKey": "lab-key-42",
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  }
}
```

`QuestBoard.Api/Properties/launchSettings.json` (fixed port 5180, no browser):

```json
{
  "$schema": "https://json.schemastore.org/launchsettings.json",
  "profiles": {
    "http": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": false,
      "applicationUrl": "http://localhost:5180",
      "environmentVariables": {
        "ASPNETCORE_ENVIRONMENT": "Development"
      }
    }
  }
}
```

### 3. Desktop: project, configuration, models

`QuestBoard.Desktop/QuestBoard.Desktop.csproj` (replace the whole file):

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <!-- Exe in Debug = a console window with your logs; WinExe in Release = no console. -->
    <OutputType Condition="'$(Configuration)' == 'Debug'">Exe</OutputType>
    <OutputType Condition="'$(Configuration)' != 'Debug'">WinExe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <ApplicationManifest>app.manifest</ApplicationManifest>
    <AvaloniaUseCompiledBindingsByDefault>true</AvaloniaUseCompiledBindingsByDefault>
  </PropertyGroup>

  <ItemGroup>
    <AvaloniaResource Include="Assets\**" />
    <Content Include="appsettings*.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Avalonia" Version="12.1.5" />
    <PackageReference Include="Avalonia.Desktop" Version="12.1.5" />
    <PackageReference Include="Avalonia.Themes.Fluent" Version="12.1.5" />
    <PackageReference Include="Avalonia.Fonts.Inter" Version="12.1.5" />
    <PackageReference Include="AvaloniaUI.DiagnosticsSupport" Version="2.2.3">
      <IncludeAssets Condition="'$(Configuration)' != 'Debug'">None</IncludeAssets>
      <PrivateAssets Condition="'$(Configuration)' != 'Debug'">All</PrivateAssets>
    </PackageReference>
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.2" />
    <PackageReference Include="Microsoft.Extensions.Hosting" Version="10.0.14" />
    <PackageReference Include="Microsoft.Extensions.Http" Version="10.0.14" />
  </ItemGroup>
</Project>
```

`QuestBoard.Desktop/appsettings.json` — note: **no API key here**:

```json
{
  "QuestApi": {
    "BaseUrl": "http://localhost:5180/",
    "TimeoutSeconds": 10
  },
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.Hosting.Lifetime": "Warning",
      "System.Net.Http.HttpClient": "Warning"
    }
  }
}
```

`QuestBoard.Desktop/Models/Quest.cs`:

```csharp
namespace QuestBoard.Desktop.Models;

// Same JSON shape as the API's records (System.Text.Json web defaults = camelCase).
public sealed record Quest(int Id, string Title, int Xp, bool Done);
public sealed record NewQuest(string Title, int Xp);
```

### 4. Desktop: services

`QuestBoard.Desktop/Services/QuestApiOptions.cs`:

```csharp
namespace QuestBoard.Desktop.Services;

// Bound from the "QuestApi" configuration section (appsettings.json, user secrets, env vars).
public sealed class QuestApiOptions
{
    public const string Section = "QuestApi";
    public string BaseUrl { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 10;
    public string? ApiKey { get; set; }
}
```

`QuestBoard.Desktop/Services/QuestApiClient.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using QuestBoard.Desktop.Models;

namespace QuestBoard.Desktop.Services;

public interface IQuestApi
{
    Task<IReadOnlyList<Quest>> GetQuestsAsync(CancellationToken ct = default);
    Task<Quest> AddQuestAsync(NewQuest quest, CancellationToken ct = default);
    Task<Quest?> CompleteAsync(int id, CancellationToken ct = default);
}

// A "typed client": IHttpClientFactory creates the HttpClient (base address, headers, timeout)
// and injects it here. View models only ever see IQuestApi.
public sealed class QuestApiClient(HttpClient http, ILogger<QuestApiClient> log) : IQuestApi
{
    public async Task<IReadOnlyList<Quest>> GetQuestsAsync(CancellationToken ct = default)
    {
        var quests = await http.GetFromJsonAsync<List<Quest>>("api/quests", ct) ?? [];
        log.LogInformation("Loaded {Count} quests from {BaseAddress}", quests.Count, http.BaseAddress);
        return quests;
    }

    public async Task<Quest> AddQuestAsync(NewQuest quest, CancellationToken ct = default)
    {
        using var response = await http.PostAsJsonAsync("api/quests", quest, ct);
        response.EnsureSuccessStatusCode();
        var created = await response.Content.ReadFromJsonAsync<Quest>(ct)
            ?? throw new InvalidOperationException("API returned an empty body.");
        log.LogInformation("Created quest {QuestId} '{Title}'", created.Id, created.Title);
        return created;
    }

    public async Task<Quest?> CompleteAsync(int id, CancellationToken ct = default)
    {
        using var response = await http.PostAsync($"api/quests/{id}/complete", content: null, ct);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<Quest>(ct);
    }
}
```

`QuestBoard.Desktop/Services/NavigationService.cs`:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using QuestBoard.Desktop.ViewModels;

namespace QuestBoard.Desktop.Services;

/// <summary>A page that may refuse to be left (unsaved changes).</summary>
public interface IConfirmNavigation
{
    Task<bool> CanLeaveAsync();
}

/// <summary>A page that wants to load data every time it becomes current.</summary>
public interface INavigationAware
{
    Task OnNavigatedToAsync();
}

public interface INavigationService
{
    ViewModelBase? Current { get; }
    bool CanGoBack { get; }
    event EventHandler? Navigated;
    Task<bool> NavigateToAsync<TViewModel>(Action<TViewModel>? init = null) where TViewModel : ViewModelBase;
    Task<bool> GoBackAsync();
}

// View-model-first navigation: we navigate to a *view model type*; the ViewLocator
// picks the matching view. Nothing here references Avalonia, so it is unit-testable.
public sealed class NavigationService(IServiceProvider services, ILogger<NavigationService> log) : INavigationService
{
    private readonly Stack<ViewModelBase> _back = new();

    public ViewModelBase? Current { get; private set; }
    public bool CanGoBack => _back.Count > 0;
    public event EventHandler? Navigated;

    public async Task<bool> NavigateToAsync<TViewModel>(Action<TViewModel>? init = null) where TViewModel : ViewModelBase
    {
        if (!await CanLeaveCurrentAsync()) return false;
        var next = services.GetRequiredService<TViewModel>();
        init?.Invoke(next);
        if (Current is not null) _back.Push(Current);
        await ShowAsync(next);
        return true;
    }

    public async Task<bool> GoBackAsync()
    {
        if (_back.Count == 0) return false;
        if (!await CanLeaveCurrentAsync()) return false;
        await ShowAsync(_back.Pop());
        return true;
    }

    private async Task<bool> CanLeaveCurrentAsync()
    {
        if (Current is IConfirmNavigation guard && !await guard.CanLeaveAsync())
        {
            log.LogInformation("Navigation away from {Page} was cancelled", Current.GetType().Name);
            return false;
        }
        return true;
    }

    private async Task ShowAsync(ViewModelBase page)
    {
        Current = page;
        log.LogInformation("Navigated to {Page} (back stack: {Depth})", page.GetType().Name, _back.Count);
        Navigated?.Invoke(this, EventArgs.Empty);
        if (page is INavigationAware aware) await aware.OnNavigatedToAsync();
    }
}
```

`QuestBoard.Desktop/Services/DialogService.cs`:

```csharp
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;

namespace QuestBoard.Desktop.Services;

// View models ask a question; they never create windows themselves.
public interface IDialogService
{
    Task<bool> ConfirmAsync(string title, string message);
    Task AlertAsync(string title, string message);
}

public sealed class DialogService : IDialogService
{
    public async Task<bool> ConfirmAsync(string title, string message)
    {
        var owner = MainWindow();
        if (owner is null) return false;
        var dialog = CreateDialog(title, message, out var buttons);
        var no = new Button { Content = "No", IsCancel = true };
        var yes = new Button { Content = "Yes", IsDefault = true };
        no.Click += (_, _) => dialog.Close(false);
        yes.Click += (_, _) => dialog.Close(true);
        buttons.Children.Add(no);
        buttons.Children.Add(yes);
        // Closing with the window's X returns default(bool) = false.
        return await dialog.ShowDialog<bool>(owner);
    }

    public async Task AlertAsync(string title, string message)
    {
        var owner = MainWindow();
        if (owner is null) return;
        var dialog = CreateDialog(title, message, out var buttons);
        var ok = new Button { Content = "OK", IsDefault = true, IsCancel = true };
        ok.Click += (_, _) => dialog.Close();
        buttons.Children.Add(ok);
        await dialog.ShowDialog(owner);
    }

    private static Window? MainWindow() =>
        (Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.MainWindow;

    private static Window CreateDialog(string title, string message, out StackPanel buttons)
    {
        buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        return new Window
        {
            Title = title,
            Width = 380,
            SizeToContent = SizeToContent.Height,
            CanResize = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new StackPanel
            {
                Margin = new Thickness(20),
                Spacing = 16,
                Children = { new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap }, buttons },
            },
        };
    }
}
```

### 5. Desktop: composition root and startup

`QuestBoard.Desktop/AppHost.cs`:

```csharp
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using QuestBoard.Desktop.Services;
using QuestBoard.Desktop.ViewModels;

namespace QuestBoard.Desktop;

// The composition root: the ONE place that knows which class implements which interface.
public static class AppHost
{
    public static IHost Build(string[]? args = null)
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            Args = args,
            // Find appsettings.json next to the .exe, not in whatever folder the user started it from.
            ContentRootPath = AppContext.BaseDirectory,
#if DEBUG
            // Debug builds run as "Development": loads appsettings.Development.json + user secrets.
            EnvironmentName = Environments.Development,
#endif
        });

        // Configuration: bind the "QuestApi" section to a typed options class.
        builder.Services.Configure<QuestApiOptions>(builder.Configuration.GetSection(QuestApiOptions.Section));

        // Typed HttpClient: the factory pools handlers (no socket exhaustion, DNS refresh).
        builder.Services.AddHttpClient<IQuestApi, QuestApiClient>((sp, http) =>
        {
            var options = sp.GetRequiredService<IOptions<QuestApiOptions>>().Value;
            http.BaseAddress = new Uri(options.BaseUrl);          // must end with "/"
            http.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
            if (!string.IsNullOrEmpty(options.ApiKey))
                http.DefaultRequestHeaders.Add("X-Api-Key", options.ApiKey);
        });

        // App services: one of each for the whole app.
        builder.Services.AddSingleton<INavigationService, NavigationService>();
        builder.Services.AddSingleton<IDialogService, DialogService>();

        // View models: the shell lives forever, pages are created fresh on every navigation.
        builder.Services.AddSingleton<MainWindowViewModel>();
        builder.Services.AddTransient<QuestListViewModel>();
        builder.Services.AddTransient<QuestEditorViewModel>();

        return builder.Build();
    }
}
```

`QuestBoard.Desktop/App.axaml.cs` (replace; keep the template's `App.axaml`, `Program.cs`,
`ViewLocator.cs` and `ViewModels/ViewModelBase.cs` unchanged):

```csharp
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using QuestBoard.Desktop.Services;
using QuestBoard.Desktop.ViewModels;
using QuestBoard.Desktop.Views;

namespace QuestBoard.Desktop;

public partial class App : Application
{
    private IHost? _host;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        _host = AppHost.Build(Environment.GetCommandLineArgs()[1..]);
        _host.Start();

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            desktop.MainWindow = new MainWindow
            {
                DataContext = _host.Services.GetRequiredService<MainWindowViewModel>(),
            };
            desktop.Exit += (_, _) =>
            {
                _host.StopAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult();
                _host.Dispose();
            };
            // First page. Fire-and-forget is OK here: errors are handled inside the view model.
            _ = _host.Services.GetRequiredService<INavigationService>().NavigateToAsync<QuestListViewModel>();
        }

        base.OnFrameworkInitializationCompleted();
    }
}
```

### 6. Desktop: view models

`QuestBoard.Desktop/ViewModels/MainWindowViewModel.cs`:

```csharp
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QuestBoard.Desktop.Services;

namespace QuestBoard.Desktop.ViewModels;

// The shell: shows whatever page the navigation service says is current.
public partial class MainWindowViewModel : ViewModelBase
{
    private readonly INavigationService _nav;

    public MainWindowViewModel(INavigationService nav)
    {
        _nav = nav;
        _nav.Navigated += (_, _) =>
        {
            CurrentPage = _nav.Current;
            BackCommand.NotifyCanExecuteChanged();
        };
    }

    [ObservableProperty]
    public partial ViewModelBase? CurrentPage { get; set; }

    [RelayCommand(CanExecute = nameof(CanGoBack))]
    private Task BackAsync() => _nav.GoBackAsync();

    private bool CanGoBack() => _nav.CanGoBack;
}
```

`QuestBoard.Desktop/ViewModels/QuestListViewModel.cs`:

```csharp
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.Logging;
using QuestBoard.Desktop.Models;
using QuestBoard.Desktop.Services;

namespace QuestBoard.Desktop.ViewModels;

public partial class QuestListViewModel(
    IQuestApi api,
    INavigationService nav,
    IDialogService dialogs,
    ILogger<QuestListViewModel> log) : ViewModelBase, INavigationAware
{
    public ObservableCollection<Quest> Quests { get; } = [];

    [ObservableProperty]
    public partial bool IsBusy { get; set; }

    [ObservableProperty]
    public partial string? Error { get; set; }

    public Task OnNavigatedToAsync() => LoadAsync();

    [RelayCommand]
    private async Task LoadAsync()
    {
        IsBusy = true;
        Error = null;
        try
        {
            var quests = await api.GetQuestsAsync();
            Quests.Clear();
            foreach (var q in quests) Quests.Add(q);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            log.LogWarning(ex, "Could not load quests");
            Error = "Can't reach the QuestBoard API. Is it running? (" + ex.Message + ")";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private Task NewQuestAsync() => nav.NavigateToAsync<QuestEditorViewModel>();

    [RelayCommand]
    private async Task CompleteAsync(Quest quest)
    {
        if (quest.Done) return;
        if (!await dialogs.ConfirmAsync("Complete quest", $"Mark \"{quest.Title}\" as done (+{quest.Xp} XP)?"))
            return;
        if (await api.CompleteAsync(quest.Id) is null)
            await dialogs.AlertAsync("Not found", "That quest no longer exists on the server.");
        await LoadAsync();
    }
}
```

`QuestBoard.Desktop/ViewModels/QuestEditorViewModel.cs`:

```csharp
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QuestBoard.Desktop.Models;
using QuestBoard.Desktop.Services;

namespace QuestBoard.Desktop.ViewModels;

public partial class QuestEditorViewModel(IQuestApi api, INavigationService nav, IDialogService dialogs)
    : ViewModelBase, IConfirmNavigation
{
    private bool _saved;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand))]
    public partial string Title { get; set; } = "";

    [ObservableProperty]
    public partial decimal? Xp { get; set; } = 10;

    public bool IsDirty => !_saved && !string.IsNullOrWhiteSpace(Title);

    [RelayCommand(CanExecute = nameof(CanSave))]
    private async Task SaveAsync()
    {
        try
        {
            await api.AddQuestAsync(new NewQuest(Title.Trim(), (int)(Xp ?? 0)));
        }
        catch (HttpRequestException ex)
        {
            await dialogs.AlertAsync("Save failed", ex.Message);
            return;
        }
        _saved = true;
        await nav.GoBackAsync();
    }

    private bool CanSave() => !string.IsNullOrWhiteSpace(Title);

    [RelayCommand]
    private Task CancelAsync() => nav.GoBackAsync();

    // The navigation guard: asked by NavigationService before this page is left.
    public async Task<bool> CanLeaveAsync() =>
        !IsDirty || await dialogs.ConfirmAsync("Discard quest?", "You have unsaved changes. Leave anyway?");
}
```

### 7. Desktop: views

`QuestBoard.Desktop/Views/MainWindow.axaml` (replace):

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.Desktop.ViewModels"
        x:Class="QuestBoard.Desktop.Views.MainWindow"
        x:DataType="vm:MainWindowViewModel"
        Icon="/Assets/avalonia-logo.ico"
        Width="560" Height="480"
        Title="QuestBoard">
  <DockPanel>
    <Border DockPanel.Dock="Top" Padding="12,8" Background="{DynamicResource SystemControlBackgroundBaseLowBrush}">
      <StackPanel Orientation="Horizontal" Spacing="12">
        <Button Content="← Back" Command="{Binding BackCommand}" />
        <TextBlock Text="QuestBoard" FontSize="18" FontWeight="SemiBold" VerticalAlignment="Center" />
      </StackPanel>
    </Border>
    <!-- The ViewLocator turns the current page view model into its view. -->
    <ContentControl Content="{Binding CurrentPage}" Margin="16" />
  </DockPanel>
</Window>
```

`QuestBoard.Desktop/Views/MainWindow.axaml.cs` (replace):

```csharp
using Avalonia.Controls;

namespace QuestBoard.Desktop.Views;

public partial class MainWindow : Window
{
    public MainWindow() => InitializeComponent();
}
```

`QuestBoard.Desktop/Views/QuestListView.axaml`:

```xml
<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="using:QuestBoard.Desktop.ViewModels"
             xmlns:m="using:QuestBoard.Desktop.Models"
             x:Class="QuestBoard.Desktop.Views.QuestListView"
             x:DataType="vm:QuestListViewModel">
  <DockPanel>
    <StackPanel DockPanel.Dock="Top" Orientation="Horizontal" Spacing="8" Margin="0,0,0,12">
      <Button Content="New quest" Command="{Binding NewQuestCommand}" />
      <Button Content="Refresh" Command="{Binding LoadCommand}" />
      <TextBlock Text="Loading…" IsVisible="{Binding IsBusy}" VerticalAlignment="Center" />
    </StackPanel>
    <TextBlock DockPanel.Dock="Top" Text="{Binding Error}" IsVisible="{Binding Error, Converter={x:Static ObjectConverters.IsNotNull}}"
               Foreground="OrangeRed" TextWrapping="Wrap" Margin="0,0,0,12" />
    <ScrollViewer>
      <ItemsControl x:Name="QuestItems" ItemsSource="{Binding Quests}">
        <ItemsControl.ItemTemplate>
          <DataTemplate x:DataType="m:Quest">
            <Grid ColumnDefinitions="*,Auto,Auto" Margin="0,4">
              <TextBlock Text="{Binding Title}" VerticalAlignment="Center" />
              <TextBlock Grid.Column="1" Text="{Binding Xp, StringFormat='{}{0} XP'}" Margin="12,0" VerticalAlignment="Center" />
              <!-- The item's DataContext is a Quest, so reach up to the list's view model for the command. -->
              <Button Grid.Column="2" Content="Complete" IsEnabled="{Binding !Done}"
                      Command="{Binding #QuestItems.((vm:QuestListViewModel)DataContext).CompleteCommand}"
                      CommandParameter="{Binding}" />
            </Grid>
          </DataTemplate>
        </ItemsControl.ItemTemplate>
      </ItemsControl>
    </ScrollViewer>
  </DockPanel>
</UserControl>
```

`QuestBoard.Desktop/Views/QuestListView.axaml.cs`:

```csharp
using Avalonia.Controls;

namespace QuestBoard.Desktop.Views;

public partial class QuestListView : UserControl
{
    public QuestListView() => InitializeComponent();
}
```

`QuestBoard.Desktop/Views/QuestEditorView.axaml`:

```xml
<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="using:QuestBoard.Desktop.ViewModels"
             x:Class="QuestBoard.Desktop.Views.QuestEditorView"
             x:DataType="vm:QuestEditorViewModel">
  <StackPanel Spacing="12" MaxWidth="400" HorizontalAlignment="Left">
    <TextBlock Text="New quest" FontSize="16" FontWeight="SemiBold" />
    <TextBox Text="{Binding Title}" PlaceholderText="What needs doing?" />
    <NumericUpDown Value="{Binding Xp}" Minimum="0" Maximum="1000" Increment="5" />
    <StackPanel Orientation="Horizontal" Spacing="8">
      <Button Content="Cancel" Command="{Binding CancelCommand}" />
      <Button Content="Save" Command="{Binding SaveCommand}" Classes="accent" />
    </StackPanel>
  </StackPanel>
</UserControl>
```

`QuestBoard.Desktop/Views/QuestEditorView.axaml.cs`:

```csharp
using Avalonia.Controls;

namespace QuestBoard.Desktop.Views;

public partial class QuestEditorView : UserControl
{
    public QuestEditorView() => InitializeComponent();
}
```

`#QuestItems.((vm:QuestListViewModel)DataContext).CompleteCommand` is a compiled binding that reaches
the `ItemsControl` named `QuestItems` and casts its `DataContext` — the usual way to call a list-level
command from inside an item template.

### 8. Store the API key as a user secret

```bash
dotnet user-secrets init --project QuestBoard.Desktop
dotnet user-secrets set "QuestApi:ApiKey" "lab-key-42" --project QuestBoard.Desktop
```

Expected output (your GUID differs):

```text
Set UserSecretsId to '37813427-69cc-49b2-ae53-5da40c87cf92' for MSBuild project '…/QuestBoard.Desktop/QuestBoard.Desktop.csproj'.
Successfully saved QuestApi:ApiKey to the secret store.
```

`init` adds a `<UserSecretsId>` line to the csproj. The value lives in
`~/.microsoft/usersecrets/<id>/secrets.json` (Windows: `%APPDATA%\Microsoft\UserSecrets\<id>\`) —
outside the repo. Because Debug builds run as `Development`, the host loads it automatically and it
lands in `QuestApiOptions.ApiKey`.

### 9. Run it

Terminal 1:

```bash
dotnet run --project QuestBoard.Api
```

```text
info: Microsoft.Hosting.Lifetime[14]
      Now listening on: http://localhost:5180
```

Terminal 2 — check the key is enforced (on Windows PowerShell type `curl.exe`):

```bash
curl -i http://localhost:5180/api/quests
curl -H "X-Api-Key: lab-key-42" http://localhost:5180/api/quests
```

```text
HTTP/1.1 401 Unauthorized
…
[{"id":1,"title":"Install the .NET 10 SDK","xp":10,"done":false},{"id":2,"title":"Build QuestBoard","xp":50,"done":false},{"id":3,"title":"Defeat the BranchStory boss","xp":200,"done":false}]
```

Then start the desktop app:

```bash
dotnet run --project QuestBoard.Desktop
```

A window shows the three quests and the console prints:

```text
info: QuestBoard.Desktop.Services.NavigationService[0]
      Navigated to QuestListViewModel (back stack: 0)
info: QuestBoard.Desktop.Services.QuestApiClient[0]
      Loaded 3 quests from http://localhost:5180/
```

Now try every path:

1. **New quest** → editor (`back stack: 1`, Back button enabled). Save is disabled until you type a title.
2. Type a title and press **Back** → "Discard quest?" dialog. **No** keeps you on the page (log: `Navigation away from QuestEditorViewModel was cancelled`).
3. Press **Save** → back on the list, reloaded with 4 quests (`Created quest 4 '…'`).
4. **Complete** a quest → confirm dialog → its button turns disabled.
5. Stop the API (Ctrl+C in terminal 1) and press **Refresh** → a red "Can't reach the QuestBoard API" message, and a `warn:` log line with the exception. Start the API again and Refresh.

### 10. Tests

`QuestBoard.Desktop.Tests/Fakes.cs`:

```csharp
using System.Net;
using System.Text;
using QuestBoard.Desktop.Models;
using QuestBoard.Desktop.Services;

namespace QuestBoard.Desktop.Tests;

// Answers every confirm with a fixed value and records what was asked.
public sealed class FakeDialogs(bool answer) : IDialogService
{
    public List<string> Asked { get; } = [];
    public Task<bool> ConfirmAsync(string title, string message) { Asked.Add(title); return Task.FromResult(answer); }
    public Task AlertAsync(string title, string message) { Asked.Add(title); return Task.CompletedTask; }
}

public sealed class FakeQuestApi : IQuestApi
{
    public List<NewQuest> Added { get; } = [];
    public Task<IReadOnlyList<Quest>> GetQuestsAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<Quest>>([new Quest(1, "Seeded", 10, false)]);
    public Task<Quest> AddQuestAsync(NewQuest quest, CancellationToken ct = default)
    {
        Added.Add(quest);
        return Task.FromResult(new Quest(99, quest.Title, quest.Xp, false));
    }
    public Task<Quest?> CompleteAsync(int id, CancellationToken ct = default) => Task.FromResult<Quest?>(null);
}

// Replaces the network: records the request, returns a canned response.
public sealed class StubHandler(HttpStatusCode status, string json) : HttpMessageHandler
{
    public HttpRequestMessage? LastRequest { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        LastRequest = request;
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        });
    }
}
```

`QuestBoard.Desktop.Tests/NavigationTests.cs`:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using QuestBoard.Desktop.Services;
using QuestBoard.Desktop.ViewModels;

namespace QuestBoard.Desktop.Tests;

public class NavigationTests
{
    public sealed class HomePage : ViewModelBase { }
    public sealed class GuardedPage : ViewModelBase, IConfirmNavigation
    {
        public bool Allow { get; set; } = true;
        public Task<bool> CanLeaveAsync() => Task.FromResult(Allow);
    }

    private static NavigationService Create()
    {
        var sp = new ServiceCollection()
            .AddTransient<HomePage>()
            .AddTransient<GuardedPage>()
            .BuildServiceProvider();
        return new NavigationService(sp, NullLogger<NavigationService>.Instance);
    }

    [Fact]
    public async Task Push_then_back_returns_to_the_same_instance()
    {
        var nav = Create();
        await nav.NavigateToAsync<HomePage>();
        var home = nav.Current;
        await nav.NavigateToAsync<GuardedPage>();

        Assert.True(nav.CanGoBack);
        Assert.True(await nav.GoBackAsync());
        Assert.Same(home, nav.Current);
        Assert.False(nav.CanGoBack);
    }

    [Fact]
    public async Task Guard_can_cancel_going_back()
    {
        var nav = Create();
        await nav.NavigateToAsync<HomePage>();
        await nav.NavigateToAsync<GuardedPage>(p => p.Allow = false);

        Assert.False(await nav.GoBackAsync());
        Assert.IsType<GuardedPage>(nav.Current);
    }

    [Fact]
    public async Task Navigated_event_fires_on_every_change()
    {
        var nav = Create();
        var count = 0;
        nav.Navigated += (_, _) => count++;
        await nav.NavigateToAsync<HomePage>();
        await nav.NavigateToAsync<HomePage>();
        await nav.GoBackAsync();
        Assert.Equal(3, count);
    }
}
```

`QuestBoard.Desktop.Tests/QuestApiClientTests.cs`:

```csharp
using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using QuestBoard.Desktop.Services;

namespace QuestBoard.Desktop.Tests;

public class QuestApiClientTests
{
    [Fact]
    public async Task GetQuests_calls_the_right_url_and_parses_camelCase_json()
    {
        var handler = new StubHandler(HttpStatusCode.OK, """[{"id":1,"title":"Build QuestBoard","xp":50,"done":false}]""");
        var http = new HttpClient(handler) { BaseAddress = new Uri("http://localhost:5180/") };
        var client = new QuestApiClient(http, NullLogger<QuestApiClient>.Instance);

        var quests = await client.GetQuestsAsync();

        Assert.Equal("http://localhost:5180/api/quests", handler.LastRequest!.RequestUri!.ToString());
        Assert.Equal("Build QuestBoard", Assert.Single(quests).Title);
    }

    [Fact]
    public async Task Complete_returns_null_on_404()
    {
        var handler = new StubHandler(HttpStatusCode.NotFound, "");
        var http = new HttpClient(handler) { BaseAddress = new Uri("http://localhost:5180/") };
        var client = new QuestApiClient(http, NullLogger<QuestApiClient>.Instance);

        Assert.Null(await client.CompleteAsync(42));
    }
}
```

`QuestBoard.Desktop.Tests/EditorAndHostTests.cs`:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using QuestBoard.Desktop.Services;
using QuestBoard.Desktop.ViewModels;

namespace QuestBoard.Desktop.Tests;

public class EditorAndHostTests
{
    [Fact]
    public void Save_is_disabled_until_a_title_is_typed()
    {
        var vm = new QuestEditorViewModel(new FakeQuestApi(), new NavigationService(new ServiceCollection().BuildServiceProvider(), NullLogger<NavigationService>.Instance), new FakeDialogs(true));
        Assert.False(vm.SaveCommand.CanExecute(null));
        vm.Title = "Write the lesson";
        Assert.True(vm.SaveCommand.CanExecute(null));
    }

    [Fact]
    public async Task Dirty_editor_asks_before_leaving()
    {
        var dialogs = new FakeDialogs(answer: false);
        var vm = new QuestEditorViewModel(new FakeQuestApi(), new NavigationService(new ServiceCollection().BuildServiceProvider(), NullLogger<NavigationService>.Instance), dialogs);
        vm.Title = "Half-typed";

        Assert.False(await vm.CanLeaveAsync());
        Assert.Equal(["Discard quest?"], dialogs.Asked);
    }

    [Fact]
    public void Container_can_build_every_view_model()
    {
        using var host = AppHost.Build();
        Assert.NotNull(host.Services.GetRequiredService<MainWindowViewModel>());
        Assert.NotNull(host.Services.GetRequiredService<QuestListViewModel>());
        Assert.NotNull(host.Services.GetRequiredService<QuestEditorViewModel>());
    }
}
```

```bash
dotnet test
```

```text
Passed!  - Failed:     0, Passed:     8, Skipped:     0, Total:     8
```

None of these tests open a window or touch the network — that is the payoff of DI, a UI-free
navigation service and an `IDialogService`. `Container_can_build_every_view_model` catches a
forgotten registration before a user does.

:::tip title="Clean up"
`dotnet user-secrets clear --project QuestBoard.Desktop` removes the stored key when you're done.
:::

- [ ] `curl` without the header returns `401`; with `X-Api-Key: lab-key-42` it returns the quest JSON
- [ ] The desktop app lists the quests from the API and logs `Loaded 3 quests from http://localhost:5180/`
- [ ] New quest → Back with a typed title shows the discard dialog, and **No** keeps you on the editor
- [ ] Saving a quest returns to the list and the new quest appears
- [ ] With the API stopped, Refresh shows a friendly error instead of crashing
- [ ] The API key is only in user secrets — not in `appsettings.json` and not in Git
- [ ] `dotnet test` reports 8 passed
:::

:::pro title="How seniors structure this as it grows"
Split the solution into `QuestBoard.Core` (view models, interfaces, models — **no Avalonia
reference**), `QuestBoard.Desktop` (views, `DialogService`, startup) and later `QuestBoard.Mobile`
(MAUI). The Core project is then shared by both UIs and fully unit-testable, and a missing Avalonia
`using` in Core is a compile error that keeps the layers honest. Add an `Add{Feature}()` extension
method per feature (`services.AddQuests()`) once the composition root passes ~50 lines.
:::

:::cards id=dsk-07-cards1 xp=15 title="Desktop architecture"
Q: What is a composition root?
A: The single place (at startup) that registers every service — the only code that knows which class implements which interface.
Q: Singleton vs transient for a page view model?
A: Transient, so every navigation gets a fresh page. Long-lived services (API client, navigation, dialogs, shell VM) are singletons.
Q: What is a captive dependency?
A: A shorter-lived service injected into a longer-lived one (e.g. transient into singleton), which then keeps that one instance forever.
Q: View-first vs view-model-first navigation?
A: View-first creates views; view-model-first navigates to view model types and a view locator / data templates pick the view — testable without UI.
Q: What is a navigation guard?
A: A check before leaving a page (e.g. IConfirmNavigation.CanLeaveAsync) that can cancel navigation — the "unsaved changes" prompt.
Q: Why hide dialogs behind IDialogService?
A: View models stay UI-free and testable (fakes answer instantly), and each platform can show dialogs its own way.
Q: Why IHttpClientFactory / typed clients?
A: Pooled, recycled handlers (no socket exhaustion, DNS refresh) and one place for base address, headers, timeouts and handlers.
Q: BaseAddress rule?
A: End it with "/" and use relative paths without a leading "/".
Q: Can a desktop app keep an API key secret?
A: No — anything shipped is readable. Use per-user sign-in tokens in the OS credential store and keep third-party keys on your server.
Q: Configuration precedence?
A: appsettings.json → appsettings.{Env}.json → user secrets (Development) → environment variables → command line; later wins.
Q: Android emulator address of your PC?
A: 10.0.2.2 (localhost is the emulator itself).
:::

## Recap

- **DI** turns hidden `new` calls into constructor parameters; the **generic host**
  (`Host.CreateApplicationBuilder`) adds configuration and logging, and you build it yourself in
  Avalonia's `OnFrameworkInitializationCompleted` (MAUI's `MauiProgram` does it for you).
- Page view models are **transient**, app-wide services **singletons**; watch for captive dependencies.
- **View-model-first navigation**: a UI-free navigation service with a back stack and guards, plus a
  view locator that maps view models to views.
- **Dialogs** go through `IDialogService`, so view models stay testable and platform-neutral.
- Call APIs with **typed clients** from `IHttpClientFactory`; end `BaseAddress` with `/`, handle
  `HttpRequestException` and timeouts, add auth with a `DelegatingHandler`.
- Configuration layers like ASP.NET Core; **nothing shipped in a client is secret** — user secrets
  for dev, sign-in tokens in the OS credential store for users, third-party keys on the server.
- Log with **structured** templates and the exception object; give users a log file, not a console.
