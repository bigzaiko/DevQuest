---
id: dsk-08
title: Collections, Validation & Async UI
level: advanced
minutes: 110
xp: 150
summary: Keep a desktop app responsive with async commands, cancellation and progress, show thousands of rows with virtualization, and tell users exactly what's wrong with validation.
---

## Why this lesson matters

Three things separate a demo app from one people actually like using:

1. **It never freezes.** Clicking "Load" doesn't turn the window grey with "(Not Responding)" in
   the title bar.
2. **It copes with real amounts of data.** Ten quests in a demo becomes 20 000 rows in production,
   and the list still scrolls smoothly and the search box still keeps up.
3. **It tells you what's wrong.** You type "ab" into a title field and the app says *"Title needs
   at least 3 characters"* next to that field, instead of crashing or saying "Error" in a popup.

These are the bugs desktop teams get the most tickets about, and they're common interview topics
("What is the UI thread?", "How does INotifyDataErrorInfo work?"). In this lesson we cover all
three, using the **QuestBoard** app from earlier lessons. In the lab you'll add a debounced search,
a cancellable loader with a progress bar, and a validated "new quest" form.

We build on the **Data Binding & MVVM** lesson: `[ObservableProperty]`, `[RelayCommand]` and compiled
bindings (`x:DataType`) should look familiar. If they don't, revisit that lesson first.

## The UI thread: one worker, one queue

A **thread** is one independent line of execution inside your program: it runs one instruction after
another, and a program can have many threads running at the same time.

**Why:** every desktop framework (WPF, WinUI, Avalonia, MAUI) has the same rule: *only one thread
may touch the UI*. Drawing, layout, input and your event handlers all run on that thread, called
the **UI thread** (or main thread). Allowing several threads to change controls at once would need
locks everywhere and would be slow and easy to break, so frameworks keep it simple and use one.

**How it works:** the UI thread runs a **message loop** (also called the dispatcher loop). It's a
plain `while` loop: take the next job from a queue (a click, a key press, "redraw this area",
"run this callback") and run it, then take the next one, forever.

```text
UI thread:  [click] → [your handler] → [layout] → [render] → [key press] → …
                         ▲
                         └── if this takes 3 seconds, NOTHING else runs for 3 seconds
```

So the window freezes whenever one job takes a long time. Here's the classic mistake:

```csharp
// ❌ Runs on the UI thread. Window frozen for ~3 s: no redraw, no clicks.
[RelayCommand]
private void Load()
{
    Thread.Sleep(3000);                 // stands in for a slow file read / HTTP call
    Status = "Loaded";
}
```

The **Dispatcher** is the object that owns that queue. In Avalonia it's `Dispatcher.UIThread`.
You use it for two things:

```csharp
using Avalonia.Threading;

// 1. Am I on the UI thread right now?
bool onUi = Dispatcher.UIThread.CheckAccess();

// 2. "Please run this on the UI thread" from any other thread:
Dispatcher.UIThread.Post(() => Status = "Done");               // fire-and-forget
await Dispatcher.UIThread.InvokeAsync(() => Status = "Done");  // and wait until it ran
```

If a background thread changes a control directly, Avalonia throws
`InvalidOperationException: Call from invalid thread`. WPF says *"The calling thread cannot access
this object because a different thread owns it."* Same rule, different wording.

| Framework | "Run this on the UI thread" |
|---|---|
| Avalonia | `Dispatcher.UIThread.Post(...)` / `InvokeAsync(...)` |
| WPF | `Application.Current.Dispatcher.Invoke(...)` / `InvokeAsync(...)` |
| .NET MAUI | `MainThread.BeginInvokeOnMainThread(...)` / `MainThread.InvokeOnMainThreadAsync(...)` |

:::quiz id=dsk-08-q1 xp=10
A command handler on the UI thread calls `File.ReadAllText` on a 2 GB log file. What does the user
see?
- [ ] Nothing special: the OS reads files on its own thread
- [x] A frozen window: no repaint, no clicks, maybe "(Not Responding)", until the read finishes
- [ ] An `InvalidOperationException: Call from invalid thread`
- [ ] The read is automatically moved to a background thread by the Dispatcher
> The UI thread runs one job at a time from its queue. While your handler blocks, it can't take the
> next job (repaint, input), so the window freezes. "Call from invalid thread" is the *opposite*
> problem: a background thread touching UI. The Dispatcher never moves work off the UI thread for
> you; you have to do that with `async`/`await` or `Task.Run`.
:::

## async/await on the UI thread

**Why:** we want slow work *off* the UI thread, and the result back *on* it, without writing
`Dispatcher.Post` everywhere.

**How:** `await` splits your method in two. The code before `await` runs now. When the awaited task
finishes, the rest of the method (called the **continuation**) is queued to run later. *Where* it runs later depends on the
**SynchronizationContext**: an object that remembers "the thread I came from". Avalonia, WPF and
MAUI install one on the UI thread, so after `await` you're **back on the UI thread**
automatically.

```csharp
// ✅ Responsive. The UI thread is free while we wait.
[RelayCommand]
private async Task LoadAsync()
{
    Status = "Loading…";                                     // UI thread
    string text = await File.ReadAllTextAsync("quests.json"); // waiting: UI thread is free
    Status = $"Loaded {text.Length} chars";                  // back on the UI thread
}
```

Two kinds of slow work need two different tools:

- **I/O-bound** (waiting for disk, network, database): use the real async API
  (`ReadAllTextAsync`, `HttpClient.GetAsync`, `ToListAsync`). No thread is used while waiting.
- **CPU-bound** (parsing 50 MB of JSON, sorting 1 million items, resizing images): wrap it in
  `Task.Run(() => …)` so a **thread-pool** thread does the work. The thread pool is the set of
  background worker threads .NET keeps ready for you.

```csharp
var sorted = await Task.Run(() => quests.OrderBy(q => q.Title).ToList()); // CPU work off the UI thread
VisibleQuests = sorted;                                                   // UI thread again
```

:::warn title="Inside Task.Run you are NOT on the UI thread"
Code inside the `Task.Run` lambda runs on a background thread. Don't set bound properties or touch
controls there. Return a value and assign it *after* the `await`. Also don't let the background
code and the UI share one `List<T>` that someone is changing: pass a copy (`list.ToArray()`).
:::

Three rules every desktop developer learns the hard way:

- **Never block on async code** with `.Result` or `.Wait()` on the UI thread. The task wants to come
  back to the UI thread to finish, but the UI thread is stuck waiting for the task: a **deadlock**,
  and the app hangs forever.
- **Avoid `async void`** except for event handlers. An exception in an `async void` method can't be
  caught by the caller and usually crashes the app. Commands should be `async Task`.
- **`ConfigureAwait(false)`** means "I don't need to come back to the UI thread". Use it in library
  and service code (an API client), never in a view model method that sets properties after the
  `await`.

:::quiz id=dsk-08-q2 xp=10
```csharp
[RelayCommand]
private void Refresh()
{
    var quests = _api.GetQuestsAsync().Result;
    VisibleQuests = quests;
}
```
Users report that clicking **Refresh** sometimes hangs the app forever. Why?
- [ ] `GetQuestsAsync` is too slow; add a timeout
- [x] `.Result` blocks the UI thread while the task waits to resume on that same UI thread: a deadlock
- [ ] `VisibleQuests` is set from a background thread
- [ ] Commands can't call async methods
> `.Result` blocks the UI thread. If `GetQuestsAsync` awaits something without
> `ConfigureAwait(false)`, its continuation is queued back to the UI thread, which is busy waiting
> for… that continuation. Neither can move. The fix is "async all the way": make the command
> `async Task RefreshAsync()` and `await` the call.
:::

## Async commands with CommunityToolkit.Mvvm

**Why:** a button bound to a long-running command needs extra behaviour. It should be disabled while
running (so a double-click doesn't start two downloads), it should show a spinner, and the user may
want to cancel it.

**How:** when `[RelayCommand]` sits on a method that returns `Task`, the source generator (the
toolkit's compile-time code writer that turns attributes into real C# properties) creates
an **`IAsyncRelayCommand`** (an `AsyncRelayCommand`) instead of a plain `RelayCommand`. You get:

| Member | What it gives you |
|---|---|
| `IsRunning` | `true` while the task runs; bindable, so you can show a spinner |
| `CanExecute` → `false` while running | the button greys out by default (`AllowConcurrentExecutions = false`) |
| `ExecutionTask` | the running `Task` (handy in tests) |
| `ExecuteAsync(param)` | run it and `await` it (again, handy in tests) |
| `Cancel()` / `IsCancellationRequested` | cancel the `CancellationToken` passed to your method |

```csharp
// Generates LoadCommand + LoadCancelCommand (the second only works while Load is running)
[RelayCommand(IncludeCancelCommand = true)]
private async Task LoadAsync(CancellationToken ct)
{
    var quests = await _api.GetQuestsAsync(ct);
    VisibleQuests = quests;
}
```

```xml
<Button Content="Load"   Command="{Binding LoadCommand}" />
<Button Content="Cancel" Command="{Binding LoadCancelCommand}" />
<ProgressBar IsIndeterminate="True" IsVisible="{Binding LoadCommand.IsRunning}" />
```

The method is named `LoadAsync` but the command is `LoadCommand`: the generator drops the `Async`
suffix. A plain **CanExecute** rule works the same as for sync commands:

```csharp
[ObservableProperty]
[NotifyCanExecuteChangedFor(nameof(SaveCommand))]   // re-check CanSave when Title changes
public partial string Title { get; set; } = "";

private bool CanSave() => Title.Length >= 3;

[RelayCommand(CanExecute = nameof(CanSave))]
private async Task SaveAsync() => await _api.SaveAsync(Title);
```

:::warn title="Exceptions in async commands"
If an async command throws and nobody catches it, the toolkit re-throws it on the UI thread by
default and the app usually crashes. Catch expected failures (`HttpRequestException`, a timeout)
*inside* the command and turn them into a visible message (`Status = "Couldn't reach the server"`).
Also register a global handler (`AppDomain.CurrentDomain.UnhandledException`,
`TaskScheduler.UnobservedTaskException`) to log anything you missed.
:::

:::quiz id=dsk-08-q3 xp=10
You put `[RelayCommand]` on `private async Task SyncAsync(CancellationToken ct)` with
`IncludeCancelCommand = true`. Which statements are true? (Select all that apply.)
- [x] The generated property is called `SyncCommand` and is an `IAsyncRelayCommand`
- [x] By default, `SyncCommand.CanExecute` returns `false` while a sync is already running
- [x] A `SyncCancelCommand` is generated that cancels the token passed as `ct`
- [ ] The method body automatically runs on a thread-pool thread
> The generator strips `Async`, creates an `AsyncRelayCommand`, blocks concurrent runs unless you
> set `AllowConcurrentExecutions = true`, and with `IncludeCancelCommand` adds a cancel command
> wired to the token. It does **not** move your code off the UI thread. Your method starts on the
> UI thread like any click handler; only real async I/O or `Task.Run` frees it.
:::

## Cancellation and progress

**Cancellation** in .NET is *cooperative*: nobody kills your code. A **`CancellationTokenSource`**
(CTS) is the remote control. Its **`CancellationToken`** is the receiver you pass into the work. The
work checks the token and stops itself.

```csharp
var cts = new CancellationTokenSource();
CancellationToken token = cts.Token;

var work = Task.Run(() =>
{
    for (var i = 0; i < 1_000_000; i++)
    {
        token.ThrowIfCancellationRequested();   // throws OperationCanceledException if cancelled
        // … process item i …
    }
}, token);

cts.Cancel();   // e.g. from a Cancel button
try { await work; }
catch (OperationCanceledException) { Status = "Cancelled"; }   // expected, not an error
```

Async APIs accept the token too (`Task.Delay(500, token)`, `httpClient.GetAsync(url, token)`) and
throw `OperationCanceledException` (or the derived `TaskCanceledException`) when cancelled.
`new CancellationTokenSource(TimeSpan.FromSeconds(10))` cancels itself after 10 s: a timeout for
free.

**Progress** reporting uses two types: **`IProgress<T>`** (the interface the worker calls
`Report(value)` on) and **`Progress<T>`** (the implementation). The handy part:
`new Progress<T>(callback)` captures the SynchronizationContext *where it was created*. Create it on
the UI thread, and the callback runs on the UI thread even when `Report` is called from a worker.

```csharp
var progress = new Progress<int>(p => LoadPercent = p);       // created on the UI thread
await Task.Run(() => Import(files, progress, ct), ct);

static void Import(string[] files, IProgress<int> progress, CancellationToken ct)
{
    for (var i = 0; i < files.Length; i++)
    {
        ct.ThrowIfCancellationRequested();
        // … import files[i] …
        progress.Report((i + 1) * 100 / files.Length);          // safe from any thread
    }
}
```

:::tip title="Report less often"
Every `Report` queues a job on the UI thread. Reporting once per item for 1 million items floods the
queue and makes the UI *slower*. Report every N items or every ~100 ms.
:::

## Debouncing: a search box that keeps up

**Why:** a search box that filters 20 000 quests on *every key press* does 6 searches while you
type "dragon", and 5 of them are thrown away. Worse, a slow early search can finish *after* a fast
later one and overwrite the correct results with stale ones.

**How:** **debouncing** means "wait until the input has been quiet for X ms, then act once". Each
new key press *cancels* the pending search and starts a fresh timer. In a view model:

```csharp
private CancellationTokenSource? _searchCts;

partial void OnSearchTextChanged(string value)    // generated hook from [ObservableProperty]
{
    _searchCts?.Cancel();                        // the previous keystroke's search is stale
    _searchCts = new CancellationTokenSource();
    _ = SearchAsync(value, _searchCts.Token);
}

private async Task SearchAsync(string text, CancellationToken ct)
{
    try
    {
        await Task.Delay(300, ct);                                   // the debounce
        var matches = await Task.Run(() => Filter(_all, text), ct);  // CPU work off the UI thread
        VisibleQuests = matches;                                     // UI thread again
    }
    catch (OperationCanceledException) { }       // replaced by a newer keystroke
}
```

Cancelling also fixes the stale-results bug: a cancelled search never reaches the assignment. Now
build the same idea in TypeScript, where `setTimeout`/`clearTimeout` play the role of
`Task.Delay` + cancellation.

:::challenge id=dsk-08-c1 lang=ts xp=50
title: Debounced quest search
QuestBoard's search box should filter quests only after the user stops typing.

1. `filterQuests(quests, query)` returns a **new** array (don't mutate the input) of quests whose
   `title` contains the trimmed `query`, ignoring case. An empty query matches everything. Sort the
   result: unfinished quests (`done: false`) first, then higher `xp` first, then `title` A→Z
   (plain `<` / `>` string comparison is fine).
2. `createDebouncedSearch(quests, delayMs, onResults)` returns `{ setQuery, dispose }`.
   `setQuery(text)` (re)starts a timer; when `delayMs` pass with no further `setQuery`, call
   `onResults(filterQuests(quests, text))` **once** with the latest text. Do **not** call
   `onResults` synchronously inside `setQuery`. Each pause gets its own search: type, pause, type
   again, pause → two calls. `dispose()` cancels any
   pending search (like cancelling a `CancellationTokenSource` when a view closes).

hint: Keep the timer id in a variable inside `createDebouncedSearch`. `clearTimeout(timer)` then `timer = setTimeout(...)`.
hint: Sort a copy: `[...matches].sort((a, b) => ...)`. Compare `done` first (false before true), then `b.xp - a.xp`, then the titles.
hint: `title.toLowerCase().includes(query.trim().toLowerCase())`; every string includes `''`.

```ts starter
type Quest = { title: string; xp: number; done: boolean }

export function filterQuests(quests: Quest[], query: string): Quest[] {
  // TODO: case-insensitive, trimmed match + sort
  return quests
}

export function createDebouncedSearch(
  quests: Quest[],
  delayMs: number,
  onResults: (results: Quest[]) => void,
) {
  return {
    setQuery(text: string) {
      // TODO: debounce instead of searching on every key press
      onResults(filterQuests(quests, text))
    },
    dispose() {},
  }
}
```

```ts solution
type Quest = { title: string; xp: number; done: boolean }

export function filterQuests(quests: Quest[], query: string): Quest[] {
  const needle = query.trim().toLowerCase()
  return quests
    .filter((q) => q.title.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      if (a.xp !== b.xp) return b.xp - a.xp
      return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
    })
}

export function createDebouncedSearch(
  quests: Quest[],
  delayMs: number,
  onResults: (results: Quest[]) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    setQuery(text: string) {
      clearTimeout(timer)
      timer = setTimeout(() => onResults(filterQuests(quests, text)), delayMs)
    },
    dispose() {
      clearTimeout(timer)
      timer = undefined
    },
  }
}
```

```ts tests
const board = [
  { title: 'Slay dragon', xp: 50, done: false },
  { title: 'Fix login bug', xp: 80, done: false },
  { title: 'Pet the DRAGON', xp: 20, done: true },
  { title: 'Find dragon egg', xp: 80, done: false },
  { title: 'Write docs', xp: 10, done: false },
]
const titles = (qs: { title: string }[]) => qs.map((q) => q.title)

test('matches trimmed query ignoring case, sorted', () => {
  expect(titles(filterQuests(board, '  DRAGON '))).toEqual(['Find dragon egg', 'Slay dragon', 'Pet the DRAGON'])
})
test('empty query returns everything: open first, xp desc, title A-Z', () => {
  expect(titles(filterQuests(board, ''))).toEqual(['Find dragon egg', 'Fix login bug', 'Slay dragon', 'Write docs', 'Pet the DRAGON'])
})
test('does not mutate the input array', () => {
  const copy = [...board]
  filterQuests(board, '')
  expect(board).toEqual(copy)
})
test('rapid typing triggers ONE search with the last text', async () => {
  const onResults = fn()
  const s = createDebouncedSearch(board, 30, onResults)
  s.setQuery('d')
  s.setQuery('dr')
  s.setQuery('dragon')
  expect(onResults).not.toHaveBeenCalled()
  await sleep(90)
  expect(onResults).toHaveBeenCalledTimes(1)
  expect(titles(onResults.mock.calls[0][0])).toEqual(['Find dragon egg', 'Slay dragon', 'Pet the DRAGON'])
})
test('two pauses give two searches', async () => {
  const onResults = fn()
  const s = createDebouncedSearch(board, 20, onResults)
  s.setQuery('docs')
  await sleep(60)
  s.setQuery('bug')
  await sleep(60)
  expect(onResults).toHaveBeenCalledTimes(2)
  expect(titles(onResults.mock.calls[1][0])).toEqual(['Fix login bug'])
})
test('dispose cancels the pending search', async () => {
  const onResults = fn()
  const s = createDebouncedSearch(board, 20, onResults)
  s.setQuery('dragon')
  s.dispose()
  await sleep(60)
  expect(onResults).not.toHaveBeenCalled()
})
```
:::

## Big lists: virtualization, DataGrid, filtering and sorting

### Virtualization

**Why:** every row in a list is a small tree of controls (a `Grid`, two `TextBlock`s, a border…).
Creating, measuring and drawing 20 000 of them takes seconds and hundreds of MB, yet the user only
ever *sees* about 20.

**How:** **UI virtualization** creates controls only for the rows in view (plus a few extra), and
**recycles** them as you scroll: the control that showed row 1 gets the data of row 41 and moves
down. The list still holds 20 000 *data items*; it just doesn't build 20 000 *controls*.

In Avalonia, `ListBox` virtualizes by default (its default items panel is a
`VirtualizingStackPanel`). A plain `ItemsControl` uses an ordinary `StackPanel` and builds every
row, unless you set `<ItemsControl.ItemsPanel>` to a `VirtualizingStackPanel` yourself:

```xml
<ListBox ItemsSource="{Binding VisibleQuests}">
  <ListBox.ItemTemplate>
    <DataTemplate x:DataType="m:Quest">
      <TextBlock Text="{Binding Title}" />
    </DataTemplate>
  </ListBox.ItemTemplate>
</ListBox>
```

Virtualization only works if the list knows **how tall its window is**. Put the `ListBox` inside a
`StackPanel` or a `ScrollViewer`, and it's measured with *infinite* height. It then thinks every row
is visible, builds all 20 000 rows, and the app crawls. Give lists a bounded space: a `Grid` row with
`*` height, or the last child of a `DockPanel`.

```xml
<!-- ❌ StackPanel gives the ListBox infinite height: virtualization is lost -->
<StackPanel>
  <TextBox />
  <ListBox ItemsSource="{Binding VisibleQuests}" />
</StackPanel>

<!-- ✅ The * row has a fixed height (whatever is left), so only visible rows are built -->
<Grid RowDefinitions="Auto,*">
  <TextBox />
  <ListBox Grid.Row="1" ItemsSource="{Binding VisibleQuests}" />
</Grid>
```

In .NET MAUI, use **`CollectionView`** (virtualized, the replacement for the old `ListView`), and
don't put it inside a `ScrollView` or a `StackLayout` for the same reason.

:::quiz id=dsk-08-q4 xp=10
A `ListBox` with 30 000 items takes 8 seconds to appear and uses 900 MB. Its XAML parent is a
`StackPanel` inside a `ScrollViewer`. What is the most likely cause?
- [ ] `ListBox` never virtualizes; you must use `DataGrid`
- [x] The parent measures the ListBox with infinite height, so it thinks every item is visible and
  creates controls for all 30 000
- [ ] 30 000 items is above Avalonia's limit
- [ ] The `ItemTemplate` uses compiled bindings
> Virtualization creates controls only for the rows that fit in the viewport. A `StackPanel` (in
> its stacking direction) and a `ScrollViewer` offer unlimited space, so the "viewport" is the whole
> list. Put the `ListBox` in a `Grid` `*` row or as the fill child of a `DockPanel`, and let the
> ListBox's own built-in scroll viewer do the scrolling.
:::

### Changing the list: ObservableCollection or a new list?

`ObservableCollection<T>` raises a `CollectionChanged` event on every `Add`, `Remove` or `Clear`, and
the list control updates just that row. That's perfect for small edits (add one quest, delete one
quest). It's wasteful for "replace all 20 000 results after a search": 20 000 events, 20 000 small
layout updates.

For bulk changes, **build a new list and assign it** to the bound property: one `PropertyChanged`,
one refresh.

```csharp
[ObservableProperty]
public partial IReadOnlyList<Quest> VisibleQuests { get; set; } = [];

VisibleQuests = Filter(_all, SearchText);   // one notification, whatever the size
```

Like `ObservableCollection`, it must be changed on the UI thread. Large codebases often use the
**DynamicData** library for live filtered/sorted views over changing data.

### DataGrid: columns, sorting, editing

For tabular data (several columns, sortable headers, inline editing), use a **DataGrid**. In
Avalonia it's a separate package with its own theme. It is **versioned separately** from Avalonia
itself: for QuestBoard's Avalonia 12.1.5, use DataGrid **12.1.2** (the newest 12.x DataGrid at the
time of writing; it builds against Avalonia 12.1.5 without warnings).

```bash
dotnet add package Avalonia.Controls.DataGrid --version 12.1.2
```

:::warn title="Always pin the DataGrid version"
`dotnet add package Avalonia.Controls.DataGrid` without `--version` picks the newest package, which
may need a newer Avalonia than your project uses. On an older 11.3.22 project, for example, a 12.x
DataGrid makes the restore fail with `NU1605: Detected package downgrade: Avalonia from 12.0.0 to
11.3.22` (the 11.x line ends at DataGrid **11.3.13**). Pin the version that matches your Avalonia
major version (check the versions list on nuget.org/packages/Avalonia.Controls.DataGrid).
:::

```xml
<!-- App.axaml, inside <Application.Styles> after <FluentTheme /> -->
<StyleInclude Source="avares://Avalonia.Controls.DataGrid/Themes/Fluent.xaml" />
```

```xml
<DataGrid ItemsSource="{Binding VisibleQuests}" IsReadOnly="True"
          CanUserSortColumns="True" GridLinesVisibility="Horizontal">
  <DataGrid.Columns>
    <DataGridTextColumn Header="Title" Binding="{Binding Title}" Width="*" />
    <DataGridTextColumn Header="XP"    Binding="{Binding Xp}"    Width="80" />
    <DataGridCheckBoxColumn Header="Done" Binding="{Binding Done}" Width="70" />
  </DataGrid.Columns>
</DataGrid>
```

With compiled bindings on, the column bindings (`{Binding Title}`) are checked against the item type
of `ItemsSource` (`Quest`), so a typo is a build error, not a silent empty column. The DataGrid
virtualizes rows, and clicking a header sorts by that column. For sorting and
filtering the grid controls itself, Avalonia has `DataGridCollectionView`, a wrapper with a
`Filter` predicate and `SortDescriptions`. WPF has the same idea as `CollectionViewSource` /
`ICollectionView`.

```csharp
var view = new DataGridCollectionView(_all) { Filter = o => ((Quest)o).Xp >= 100 };
view.SortDescriptions.Add(DataGridSortDescription.FromPath(nameof(Quest.Title)));
```

:::pro title="Filter and sort in the view model, not the view"
Seniors keep filtering and sorting logic in plain C# (LINQ over a snapshot, like the lab's
`Filter` method). It's unit-testable without a UI, works the same in Avalonia, WPF and MAUI, and
can run on a background thread. Use the grid's built-in header sorting for the simple "click to
sort" case. Once the rules matter (business ordering, server-side paging), do it in the view model
or on the server with `ORDER BY` + `LIMIT`.
:::

:::quiz id=dsk-08-q5 xp=10
After every search, QuestBoard does `Quests.Clear()` and then `Quests.Add(q)` for each of 15 000
results on an `ObservableCollection<Quest>`. Typing feels sluggish. What's the best fix?
- [ ] Call `Add` from a `Task.Run` so it's off the UI thread
- [x] Compute the results (off the UI thread if slow), then assign one new list to a bound property:
  one notification instead of 15 000
- [ ] Switch from `ListBox` to `StackPanel` + `ItemsControl`
- [ ] Turn off compiled bindings
> Each `Add` raises `CollectionChanged` and makes the list do a bit of work, 15 000 times. Replacing
> the whole list sends one change. Calling `Add` from a background thread is a bug: the collection
> is bound to UI and must be changed on the UI thread. A `StackPanel` makes things worse by losing
> virtualization.
:::

## Validation: telling users what's wrong

**Why:** users make mistakes: an empty title, XP of 9 999, an email without `@`. Good apps catch
these *before* saving, show the message **next to the field**, and explain how to fix it. They also
show errors that come back from the server in the same place. (The Capstone API answers a bad request
with HTTP `400` and a **ProblemDetails** body: a standard JSON error format whose `errors` object maps
each field name to its messages.)

There are three layers to learn, from "rules" to "plumbing" to "convenience".

### 1. DataAnnotations: rules as attributes

`System.ComponentModel.DataAnnotations` is the same attribute set ASP.NET Core uses for request
validation. An **attribute** is a `[Tag]` attached to a property; validation code reads it with
**reflection** (code that inspects types and their attributes while the program runs).

| Attribute | Rule |
|---|---|
| `[Required]` | not null, not empty/whitespace string |
| `[MinLength(3)]` / `[MaxLength(60)]` / `[StringLength(60, MinimumLength = 3)]` | length |
| `[Range(5, 500)]` | number within bounds |
| `[EmailAddress]`, `[Url]`, `[Phone]` | format checks |
| `[RegularExpression("^[a-z-]+$")]` | custom pattern |
| `[CustomValidation(typeof(T), nameof(Method))]` | your own static method |

```csharp
[Required(ErrorMessage = "Title is required")]
[MinLength(3, ErrorMessage = "Title needs at least 3 characters")]
public string Title { get; set; } = "";
```

Nice detail: apart from `[Required]`, these attributes treat `null` as valid. "Optional, but if you
fill it in it must be an email" is just `[EmailAddress]` without `[Required]`.

### 2. INotifyDataErrorInfo: how the view finds out

**`INotifyDataErrorInfo`** is the interface (in `System.ComponentModel`) that WPF and Avalonia
bindings listen to for errors. It has three members:

```csharp
public interface INotifyDataErrorInfo
{
    bool HasErrors { get; }                                  // any errors at all?
    IEnumerable GetErrors(string? propertyName);             // errors for one property
    event EventHandler<DataErrorsChangedEventArgs>? ErrorsChanged; // "errors for X changed"
}
```

When a binding's source implements it, the binding subscribes to `ErrorsChanged` and calls
`GetErrors("Title")` for the property it's bound to. Avalonia then shows those errors on the control
through **`DataValidationErrors`**: a red border and the message under a `TextBox` with the Fluent
theme. You don't write any view code for that.

### 3. ObservableValidator: the toolkit does the plumbing

Implementing `INotifyDataErrorInfo` by hand means a dictionary of lists and events. CommunityToolkit's
**`ObservableValidator`** (an `ObservableObject` that also implements `INotifyDataErrorInfo`) does it
for you and runs the DataAnnotations rules:

```csharp
public partial class NewQuestViewModel : ObservableValidator
{
    [ObservableProperty]
    [NotifyDataErrorInfo]                 // validate this property every time it's set
    [Required(ErrorMessage = "Title is required")]
    [MinLength(3, ErrorMessage = "Title needs at least 3 characters")]
    public partial string Title { get; set; } = "";

    [ObservableProperty]
    [NotifyDataErrorInfo]
    [Range(5, 500, ErrorMessage = "XP must be between 5 and 500")]
    public partial int Xp { get; set; } = 50;
}
```

| Member | Use |
|---|---|
| `[NotifyDataErrorInfo]` | validate on every set (live validation) |
| `ValidateAllProperties()` | validate everything, including fields never touched (call on Save) |
| `ValidateProperty(value, name)` | validate one property manually |
| `GetErrors(name)` / `HasErrors` | read errors (e.g. for a summary or a CanExecute) |
| `ClearErrors(name?)` | clear errors, e.g. after resetting the form |

A cross-field rule ("due date must be after start date") is a `[CustomValidation]` static method that
gets the `ValidationContext`, whose `ObjectInstance` is the whole view model.

:::warn title="On Avalonia 11, errors can show twice"
Avalonia **11** also reads DataAnnotations attributes *by itself* (its `DataAnnotationsValidationPlugin`,
on by default). Combined with `ObservableValidator`, each message then appears twice, which is why
11.x templates contain a `DisableAvaloniaDataAnnotationValidation()` method that removes the plugin
from `BindingPlugins.DataValidators` at startup. Avalonia **12** no longer registers that plugin by
default (it only keeps the exception and `INotifyDataErrorInfo` validators), so QuestBoard needs no
extra code. If you see "the error shows twice" on an older project, look for that plugin first.
:::

**.NET MAUI** has no built-in display of `INotifyDataErrorInfo` errors. `ObservableValidator` still
works there; bind a `Label` to an error-message property and toggle its `IsVisible` yourself (or
use the CommunityToolkit.Maui behaviors).

:::quiz id=dsk-08-q6 xp=10
A view model derives from `ObservableValidator`. `Title` has `[Required]` and `[NotifyDataErrorInfo]`.
The form opens with an empty title and the user clicks **Save** without typing anything. Nothing
complains and an empty quest is saved. What was missing?
- [ ] `[Required]` doesn't work on strings
- [x] `ValidateAllProperties()` in the Save command: `[NotifyDataErrorInfo]` only validates when the
  property is *set*, and the user never set it
- [ ] The view needs `x:DataType` for validation to run
- [ ] `HasErrors` must be raised manually with `OnPropertyChanged`
> Live validation runs on change. A field the user never touched never changed, so it was never
> validated. Calling `ValidateAllProperties()` when saving (and stopping if `HasErrors`) catches it.
> As a bonus, you don't shout "Title is required" at someone who just opened an empty form.
:::

:::quiz id=dsk-08-q7 xp=10
Which members make up the `INotifyDataErrorInfo` interface? (Select all that apply.)
- [x] `bool HasErrors { get; }`
- [x] `IEnumerable GetErrors(string? propertyName)`
- [x] `event EventHandler<DataErrorsChangedEventArgs> ErrorsChanged`
- [ ] `void ValidateAllProperties()`
> Those three are the whole contract the binding engine relies on: "are there errors?", "which
> ones for this property?", and "tell me when they change". `ValidateAllProperties()` is a helper
> method on CommunityToolkit's `ObservableValidator`, not part of the interface.
:::

### Showing errors well

- **When:** validate a field after the user leaves it or types in it, and validate everything on
  submit. Don't show errors on an untouched, empty form.
- **Where:** next to the field (Avalonia does this automatically), plus a short summary near the
  Save button for long forms.
- **What:** say how to fix it: "Title needs at least 3 characters", not "Invalid input".
- **Submit button:** either keep it enabled and validate on click (users discover what's missing),
  or disable it with `CanExecute => !HasErrors`. A disabled button with no explanation is the
  number-one "the app is broken" complaint, so if you disable it, show *why*.
- **Server errors:** the server is the final authority (another user may have taken the name).
  Map API field errors into the same mechanism, e.g. a custom method on your validator that adds
  errors for a property, so they appear in the same place as local ones.

:::job title="What validation looks like at work"
In real codebases you'll find validation rules in three places: attributes or FluentValidation rules
(FluentValidation is a popular library that writes rules as code: `RuleFor(x => x.Title).MinimumLength(3)`)
in the **view model** (fast feedback), the same rules again in the **API** (the server can't trust
clients), and **database constraints** (`NOT NULL`, `UNIQUE`, `CHECK`) as the last line of defence.
Tickets like "the error shows twice", "the error doesn't clear after fixing the field" and "Save is
greyed out and I don't know why" are typical first-week tasks.
:::

## Build a validation rule engine

Under the hood, DataAnnotations validation is a loop: for each property, run each rule, collect the
failure messages into a dictionary keyed by property name. That dictionary is exactly what
`GetErrors(propertyName)` returns from. Build one.

:::challenge id=dsk-08-c2 lang=ts xp=60
title: Per-field validation rules
Write `validate(values, schema)` that returns an object mapping **field name → list of error
messages**, containing only fields that have errors (a valid form returns `{}`). Also write
`hasErrors(errors)`.

`schema[field]` is `{ label, rules }`. Run the rules in order and collect **every** failing message,
with these exact texts (`L` = label):

| Rule | Fails when | Message |
|---|---|---|
| `{ kind: 'required' }` | value is `undefined`, `null` or a whitespace-only string | `L is required` |
| `{ kind: 'minLength', value: n }` | `String(value).length < n` | `L needs at least n characters` |
| `{ kind: 'maxLength', value: n }` | `String(value).length > n` | `L can be at most n characters` |
| `{ kind: 'range', min, max }` | `Number(value)` is `NaN` | `L must be a number` |
| `{ kind: 'range', min, max }` | `Number(value) < min` or `> max` (bounds are inclusive) | `L must be between min and max` |
| `{ kind: 'pattern', regex }` | `!regex.test(String(value))` | `L has an invalid format` |
| `{ kind: 'custom', test }` | `test(value, values)` returns a string (`values` is the whole form, for cross-field rules); `null` = ok | the returned string |

Like DataAnnotations: if the value is **empty** (as defined by `required`), skip every other rule.
A required field that's empty gets only `L is required`; an optional empty field gets no errors.
Only fields listed in `schema` are checked (extra keys in `values`, like `startDay`, are just data).
`hasErrors(errors)` returns `true` when at least one field has a message, otherwise `false`.

hint: Write a helper `isEmpty(v)`: `v === undefined || v === null || (typeof v === 'string' && v.trim() === '')`.
hint: For each field: `if (isEmpty(value))` → push the required message if there's a required rule, then `continue`.
hint: Only add the key to the result when its message list is non-empty.

```ts starter
type Rule =
  | { kind: 'required' }
  | { kind: 'minLength'; value: number }
  | { kind: 'maxLength'; value: number }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'pattern'; regex: RegExp }
  | { kind: 'custom'; test: (value: unknown, all: Record<string, unknown>) => string | null }

type FieldSchema = { label: string; rules: Rule[] }

export function validate(
  values: Record<string, unknown>,
  schema: Record<string, FieldSchema>,
): Record<string, string[]> {
  // TODO
  return {}
}

export function hasErrors(errors: Record<string, string[]>): boolean {
  return false
}
```

```ts solution
type Rule =
  | { kind: 'required' }
  | { kind: 'minLength'; value: number }
  | { kind: 'maxLength'; value: number }
  | { kind: 'range'; min: number; max: number }
  | { kind: 'pattern'; regex: RegExp }
  | { kind: 'custom'; test: (value: unknown, all: Record<string, unknown>) => string | null }

type FieldSchema = { label: string; rules: Rule[] }

const isEmpty = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

export function validate(
  values: Record<string, unknown>,
  schema: Record<string, FieldSchema>,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  for (const [field, { label, rules }] of Object.entries(schema)) {
    const value = values[field]
    const messages: string[] = []
    if (isEmpty(value)) {
      if (rules.some((r) => r.kind === 'required')) messages.push(`${label} is required`)
    } else {
      for (const rule of rules) {
        const text = String(value)
        if (rule.kind === 'minLength' && text.length < rule.value) messages.push(`${label} needs at least ${rule.value} characters`)
        if (rule.kind === 'maxLength' && text.length > rule.value) messages.push(`${label} can be at most ${rule.value} characters`)
        if (rule.kind === 'range') {
          const n = Number(value)
          if (Number.isNaN(n)) messages.push(`${label} must be a number`)
          else if (n < rule.min || n > rule.max) messages.push(`${label} must be between ${rule.min} and ${rule.max}`)
        }
        if (rule.kind === 'pattern' && !rule.regex.test(text)) messages.push(`${label} has an invalid format`)
        if (rule.kind === 'custom') {
          const msg = rule.test(value, values)
          if (msg !== null) messages.push(msg)
        }
      }
    }
    if (messages.length > 0) errors[field] = messages
  }
  return errors
}

export function hasErrors(errors: Record<string, string[]>): boolean {
  return Object.keys(errors).length > 0
}
```

```ts tests
const questSchema = {
  title: { label: 'Title', rules: [{ kind: 'required' }, { kind: 'minLength', value: 3 }, { kind: 'maxLength', value: 60 }] },
  xp: { label: 'XP', rules: [{ kind: 'required' }, { kind: 'range', min: 5, max: 500 }] },
  tag: { label: 'Tag', rules: [{ kind: 'maxLength', value: 10 }, { kind: 'pattern', regex: /^[a-z-]+$/ }] },
  dueDay: {
    label: 'Due day',
    rules: [{ kind: 'custom', test: (v: unknown, all: Record<string, unknown>) => (Number(v) < Number(all.startDay) ? 'Due day must be on or after the start day' : null) }],
  },
} as any
const good = { title: 'Slay the dragon', xp: 120, tag: 'boss', startDay: 3, dueDay: 5 }

test('a valid form has no errors', () => {
  const e = validate(good, questSchema)
  expect(e).toEqual({})
  expect(hasErrors(e)).toBe(false)
})
test('required + empty gives ONLY the required message', () => {
  expect(validate({ ...good, title: '   ' }, questSchema)).toEqual({ title: ['Title is required'] })
  expect(validate({ ...good, xp: undefined }, questSchema)).toEqual({ xp: ['XP is required'] })
})
test('length rules', () => {
  expect(validate({ ...good, title: 'ab' }, questSchema)).toEqual({ title: ['Title needs at least 3 characters'] })
  expect(validate({ ...good, title: 'x'.repeat(61) }, questSchema)).toEqual({ title: ['Title can be at most 60 characters'] })
})
test('range rule: bounds and non-numbers', () => {
  expect(validate({ ...good, xp: 1000 }, questSchema)).toEqual({ xp: ['XP must be between 5 and 500'] })
  expect(validate({ ...good, xp: 'lots' }, questSchema)).toEqual({ xp: ['XP must be a number'] })
  expect(validate({ ...good, xp: '42' }, questSchema)).toEqual({})
  expect(validate({ ...good, xp: 5 }, questSchema)).toEqual({})
})
test('collects every failing rule, in order', () => {
  expect(validate({ ...good, tag: 'THIS-IS-TOO-LONG' }, questSchema)).toEqual({
    tag: ['Tag can be at most 10 characters', 'Tag has an invalid format'],
  })
})
test('optional empty field is fine', () => {
  expect(validate({ ...good, tag: '' }, questSchema)).toEqual({})
})
test('custom rule sees all values (cross-field)', () => {
  expect(validate({ ...good, startDay: 9, dueDay: 4 }, questSchema)).toEqual({ dueDay: ['Due day must be on or after the start day'] })
})
test('several fields at once; hasErrors is true', () => {
  const e = validate({ title: '', xp: 1, tag: 'ok' }, questSchema)
  expect(e).toEqual({ title: ['Title is required'], xp: ['XP must be between 5 and 500'] })
  expect(hasErrors(e)).toBe(true)
})
```
:::

:::quiz id=dsk-08-q8 xp=10
A QuestBoard user types `abc` into the **XP** `TextBox`, which is bound to an `int Xp` property.
What happens in Avalonia?
- [ ] The app crashes with a `FormatException`
- [ ] `Xp` is set to `0`
- [x] The binding can't convert `abc` to `int`, so the property isn't updated and the TextBox shows a
  conversion error through `DataValidationErrors`
- [ ] `ObservableValidator` reports `XP must be between 5 and 500`
> Conversion happens in the binding *before* your property is set. A failed conversion never reaches
> the view model, so your `[Range]` rule doesn't run. Avalonia reports the conversion failure on the
> control itself. If you need a custom message, bind to a `string` property and parse/validate it in
> the view model, or use a `NumericUpDown`.
:::

## Lab: QuestBoard search, loading and validation

:::lab id=dsk-08-lab1 xp=100
title: QuestBoard: debounced search, cancellable loading, validated form
You'll build a self-contained QuestBoard in a fresh folder: a cancellable "Load quests" button with
a progress bar, a debounced search over 5 000 quests in a virtualized list, and a validated "New
quest" form. Then you'll prove it with unit tests that run **without** any UI.

You need the .NET 10 SDK (`dotnet --version` → `10.0.x`) and the Avalonia templates. The project
file below pins **Avalonia 12.1.5**, like every QuestBoard lab. (Verified with .NET SDK 10.0.403,
Avalonia 12.1.5 and CommunityToolkit.Mvvm 8.4.2: 0 warnings, 7/7 tests.)

### 1. Create the solution

```bash
dotnet new install Avalonia.Templates
mkdir QuestBoardLab && cd QuestBoardLab
dotnet new avalonia.mvvm -n QuestBoard -f net10.0 -m CommunityToolkit
dotnet new xunit -n QuestBoard.Tests -f net10.0
dotnet add QuestBoard.Tests reference QuestBoard
rm QuestBoard.Tests/UnitTest1.cs
mkdir -p QuestBoard/Models
```

(On Windows PowerShell use `del QuestBoard.Tests\UnitTest1.cs` and `mkdir QuestBoard\Models`.)

### 2. `QuestBoard/QuestBoard.csproj` (replace)

This turns on compiled bindings for every XAML file.

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ApplicationManifest>app.manifest</ApplicationManifest>
    <AvaloniaUseCompiledBindingsByDefault>true</AvaloniaUseCompiledBindingsByDefault>
  </PropertyGroup>

  <ItemGroup>
    <AvaloniaResource Include="Assets\**" />
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
  </ItemGroup>
</Project>
```

### 3. `QuestBoard/App.axaml.cs` (keep)

Keep the template's file: it creates `MainWindow` with a `MainViewModel` as its `DataContext`. Our
view models report errors through `INotifyDataErrorInfo` (`ObservableValidator`), and Avalonia 12
doesn't read DataAnnotations attributes by itself, so there's nothing to switch off (see the
warning in the validation section if you work on an 11.x project).

### 4. `QuestBoard/Models/Quest.cs` (new)

```csharp
using System;
using System.Collections.Generic;
using System.Threading;

namespace QuestBoard.Models;

public record Quest(string Title, int Xp, bool Done);

public static class QuestSource
{
    private static readonly string[] Verbs = ["Slay", "Fix", "Write", "Deploy", "Review", "Refactor"];
    private static readonly string[] Nouns = ["dragon", "login bug", "docs", "release", "pull request", "dashboard"];

    // Simulates a slow data source (a big file, a slow API): CPU work in chunks.
    // Runs on a background thread, so it must NOT touch UI objects.
    public static List<Quest> Generate(int count, int chunkDelayMs,
        IProgress<int>? progress, CancellationToken ct)
    {
        var list = new List<Quest>(count);
        const int chunk = 500;
        for (var i = 0; i < count; i++)
        {
            if (i % chunk == 0)
            {
                ct.ThrowIfCancellationRequested();   // cooperative cancellation
                progress?.Report(i * 100 / count);
                if (chunkDelayMs > 0) Thread.Sleep(chunkDelayMs);
            }
            var title = $"{Verbs[i % Verbs.Length]} {Nouns[i / Verbs.Length % Nouns.Length]} #{i}";
            list.Add(new Quest(title, 5 + i * 37 % 200, i % 7 == 0));
        }
        progress?.Report(100);
        return list;
    }
}
```

### 5. `QuestBoard/ViewModels/NewQuestViewModel.cs` (new)

```csharp
using System.ComponentModel.DataAnnotations;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;
using QuestBoard.Models;

namespace QuestBoard.ViewModels;

// ObservableValidator = ObservableObject + INotifyDataErrorInfo + DataAnnotations support.
public partial class NewQuestViewModel : ObservableValidator
{
    public NewQuestViewModel()
    {
        // Re-announce the summary whenever the set of errors changes.
        ErrorsChanged += (_, _) => OnPropertyChanged(nameof(ErrorSummary));
    }

    [ObservableProperty]
    [NotifyDataErrorInfo]
    [Required(ErrorMessage = "Title is required")]
    [MinLength(3, ErrorMessage = "Title needs at least 3 characters")]
    [MaxLength(60, ErrorMessage = "Title can be at most 60 characters")]
    public partial string Title { get; set; } = "";

    [ObservableProperty]
    [NotifyDataErrorInfo]
    [Range(5, 500, ErrorMessage = "XP must be between 5 and 500")]
    public partial int Xp { get; set; } = 50;

    public string ErrorSummary =>
        string.Join("\n", GetErrors().Select(e => e.ErrorMessage));

    // Validate everything (including fields the user never touched) before saving.
    public Quest? TryCreate()
    {
        ValidateAllProperties();
        return HasErrors ? null : new Quest(Title.Trim(), Xp, false);
    }

    public void Reset()
    {
        Title = "";
        Xp = 50;
        ClearErrors();   // an empty, fresh form should not shout at the user
    }
}
```

### 6. `QuestBoard/ViewModels/MainViewModel.cs` (replace)

```csharp
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QuestBoard.Models;

namespace QuestBoard.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly int _questCount;
    private readonly int _chunkDelayMs;
    private readonly List<Quest> _all = new();
    private CancellationTokenSource? _searchCts;

    public MainViewModel() : this(questCount: 5000, chunkDelayMs: 150) { }

    public MainViewModel(int questCount, int chunkDelayMs)
    {
        _questCount = questCount;
        _chunkDelayMs = chunkDelayMs;
    }

    public NewQuestViewModel NewQuest { get; } = new();

    public TimeSpan SearchDelay { get; init; } = TimeSpan.FromMilliseconds(300);

    // The latest search, exposed so tests can await it.
    public Task SearchTask { get; private set; } = Task.CompletedTask;

    [ObservableProperty]
    public partial IReadOnlyList<Quest> VisibleQuests { get; set; } = [];

    [ObservableProperty]
    public partial string SearchText { get; set; } = "";

    [ObservableProperty]
    public partial string Status { get; set; } = "No quests loaded yet";

    [ObservableProperty]
    public partial int LoadPercent { get; set; }

    // Generated by [ObservableProperty]: runs after SearchText changes.
    partial void OnSearchTextChanged(string value)
    {
        _searchCts?.Cancel();                    // the previous keystroke's search is stale
        _searchCts = new CancellationTokenSource();
        SearchTask = DebouncedSearchAsync(value, _searchCts.Token);
    }

    private async Task DebouncedSearchAsync(string text, CancellationToken ct)
    {
        try
        {
            await Task.Delay(SearchDelay, ct);   // debounce: wait for the typing to pause
            var snapshot = _all.ToArray();       // never share a mutable list across threads
            var matches = await Task.Run(() => Filter(snapshot, text), ct);
            ct.ThrowIfCancellationRequested();
            VisibleQuests = matches;             // back on the UI thread (Avalonia's SynchronizationContext)
            Status = $"{matches.Count} of {_all.Count} quests match";
        }
        catch (OperationCanceledException)
        {
            // A newer keystroke replaced this search: nothing to do.
        }
    }

    public static List<Quest> Filter(IEnumerable<Quest> quests, string text)
    {
        var needle = text.Trim();
        return quests
            .Where(q => q.Title.Contains(needle, StringComparison.OrdinalIgnoreCase))
            .OrderBy(q => q.Done)
            .ThenByDescending(q => q.Xp)
            .ThenBy(q => q.Title, StringComparer.Ordinal)
            .ToList();
    }

    // Generates LoadCommand (an IAsyncRelayCommand) and LoadCancelCommand.
    [RelayCommand(IncludeCancelCommand = true)]
    private async Task LoadAsync(CancellationToken ct)
    {
        Status = "Loading…";
        LoadPercent = 0;
        // Progress<T> captures the current SynchronizationContext, so the callback
        // runs on the UI thread even though Report() is called from a worker thread.
        var progress = new Progress<int>(p => LoadPercent = p);
        try
        {
            var quests = await Task.Run(
                () => QuestSource.Generate(_questCount, _chunkDelayMs, progress, ct), ct);
            _all.Clear();
            _all.AddRange(quests);
            VisibleQuests = Filter(_all, SearchText);
            Status = $"{_all.Count} quests loaded";
        }
        catch (OperationCanceledException)
        {
            Status = "Load cancelled";
        }
    }

    [RelayCommand]
    private void AddQuest()
    {
        var quest = NewQuest.TryCreate();
        if (quest is null) return;               // errors are now visible in the form
        _all.Add(quest);
        VisibleQuests = Filter(_all, SearchText);
        Status = $"Added \"{quest.Title}\"";
        NewQuest.Reset();
    }
}
```

### 7. `QuestBoard/Views/MainWindow.axaml` (replace)

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.ViewModels"
        xmlns:m="using:QuestBoard.Models"
        xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
        xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
        mc:Ignorable="d" d:DesignWidth="720" d:DesignHeight="560"
        x:Class="QuestBoard.Views.MainWindow"
        x:DataType="vm:MainViewModel"
        Icon="/Assets/avalonia-logo.ico"
        Width="720" Height="560"
        Title="QuestBoard">

    <Design.DataContext>
        <vm:MainViewModel />
    </Design.DataContext>

    <DockPanel Margin="16">
        <StackPanel DockPanel.Dock="Top" Spacing="8">
            <StackPanel Orientation="Horizontal" Spacing="8">
                <Button Content="Load quests" Command="{Binding LoadCommand}" />
                <Button Content="Cancel" Command="{Binding LoadCancelCommand}" />
                <ProgressBar Width="220" Minimum="0" Maximum="100"
                             Value="{Binding LoadPercent}" ShowProgressText="True" />
            </StackPanel>
            <TextBlock Text="{Binding Status}" />
            <TextBox PlaceholderText="Search quests…" Text="{Binding SearchText}" />
        </StackPanel>

        <Border DockPanel.Dock="Bottom" Margin="0,12,0,0" Padding="12"
                BorderBrush="Gray" BorderThickness="1" CornerRadius="6">
            <StackPanel Spacing="8">
                <TextBlock Text="New quest" FontWeight="SemiBold" />
                <TextBox PlaceholderText="Title" Text="{Binding NewQuest.Title}" />
                <TextBox PlaceholderText="XP (5–500)" Text="{Binding NewQuest.Xp}" />
                <TextBlock Foreground="IndianRed" TextWrapping="Wrap"
                           Text="{Binding NewQuest.ErrorSummary}"
                           IsVisible="{Binding NewQuest.HasErrors}" />
                <Button Content="Add quest" Command="{Binding AddQuestCommand}" />
            </StackPanel>
        </Border>

        <!-- ListBox virtualizes by default: only the visible rows get real controls. -->
        <ListBox Margin="0,12,0,0" ItemsSource="{Binding VisibleQuests}">
            <ListBox.ItemTemplate>
                <DataTemplate x:DataType="m:Quest">
                    <Grid ColumnDefinitions="*,Auto">
                        <TextBlock Text="{Binding Title}" />
                        <TextBlock Grid.Column="1" Text="{Binding Xp, StringFormat='{}{0} XP'}" />
                    </Grid>
                </DataTemplate>
            </ListBox.ItemTemplate>
        </ListBox>
    </DockPanel>
</Window>
```

The `ListBox` is the *last* child of the `DockPanel`, so it fills the remaining space with a fixed
height and keeps virtualization.

### 8. `QuestBoard.Tests/QuestBoardTests.cs` (new)

The view models never touch a control, so they can be tested with plain xUnit: no window, no
display.

```csharp
using QuestBoard.Models;
using QuestBoard.ViewModels;

namespace QuestBoard.Tests;

public class QuestBoardTests
{
    private static MainViewModel NewVm() =>
        new(questCount: 3000, chunkDelayMs: 0) { SearchDelay = TimeSpan.FromMilliseconds(50) };

    [Fact]
    public void Filter_is_case_insensitive_and_sorted()
    {
        var quests = new[]
        {
            new Quest("Slay DRAGON", 10, false),
            new Quest("Fix bug", 99, false),
            new Quest("Pet dragon", 50, true),
            new Quest("Find dragon", 80, false),
        };
        var result = MainViewModel.Filter(quests, " dragon ");
        Assert.Equal(["Find dragon", "Slay DRAGON", "Pet dragon"], result.Select(q => q.Title));
    }

    [Fact]
    public async Task Load_fills_the_list()
    {
        var vm = NewVm();
        await vm.LoadCommand.ExecuteAsync(null);
        Assert.Equal(3000, vm.VisibleQuests.Count);
        Assert.Equal("3000 quests loaded", vm.Status);
    }

    [Fact]
    public async Task Search_is_debounced_and_only_the_last_text_wins()
    {
        var vm = NewVm();
        await vm.LoadCommand.ExecuteAsync(null);
        vm.SearchText = "d";
        vm.SearchText = "dr";
        vm.SearchText = "dragon #4";
        await vm.SearchTask;
        Assert.NotEmpty(vm.VisibleQuests);
        Assert.All(vm.VisibleQuests, q => Assert.Contains("dragon #4", q.Title, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Load_can_be_cancelled()
    {
        var vm = new MainViewModel(questCount: 5000, chunkDelayMs: 100);
        var running = vm.LoadCommand.ExecuteAsync(null);
        Assert.True(vm.LoadCommand.IsRunning);
        vm.LoadCancelCommand.Execute(null);
        await running;
        Assert.Equal("Load cancelled", vm.Status);
        Assert.Empty(vm.VisibleQuests);
    }

    [Fact]
    public void Untouched_form_shows_no_errors_until_submit()
    {
        var form = new NewQuestViewModel();
        Assert.False(form.HasErrors);
        Assert.Null(form.TryCreate());
        Assert.True(form.HasErrors);
        Assert.Contains("Title is required", form.ErrorSummary);
    }

    [Fact]
    public void Each_field_reports_its_own_error()
    {
        var form = new NewQuestViewModel { Title = "ab", Xp = 1000 };
        Assert.Contains(form.GetErrors(nameof(NewQuestViewModel.Title)),
            e => e.ErrorMessage == "Title needs at least 3 characters");
        Assert.Contains(form.GetErrors(nameof(NewQuestViewModel.Xp)),
            e => e.ErrorMessage == "XP must be between 5 and 500");
    }

    [Fact]
    public async Task Valid_quest_is_added_and_form_resets()
    {
        var vm = NewVm();
        await vm.LoadCommand.ExecuteAsync(null);
        vm.NewQuest.Title = "  Ship the search box  ";
        vm.NewQuest.Xp = 120;
        vm.AddQuestCommand.Execute(null);
        Assert.Contains(vm.VisibleQuests, q => q.Title == "Ship the search box" && q.Xp == 120);
        Assert.Equal("", vm.NewQuest.Title);
        Assert.False(vm.NewQuest.HasErrors);
    }
}
```

### 9. Build, test, run

```bash
dotnet build QuestBoard
dotnet test QuestBoard.Tests
dotnet run --project QuestBoard
```

Expected output (the build and test lines; wording may be localized):

```text
Build succeeded.
    0 Warning(s)
    0 Error(s)
…
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7
```

### 10. Try it in the running app

1. Click **Load quests**. The progress bar climbs to 100 % over about 1.5 s, and **you can still
   drag and resize the window** while it loads. Load is greyed out while it runs.
2. Click **Load quests** again and press **Cancel** half-way: the status says `Load cancelled`.
3. Load again, then type `dragon #4` quickly into the search box. The list updates once, about
   300 ms after you stop typing (status like `… of 5000 quests match`). Scroll the list: it stays
   smooth because only visible rows exist.
4. Click **Add quest** with an empty title: the Title box turns red with *Title is required*, and
   the summary appears. Type `ab`: the message changes to *needs at least 3 characters*. Type a
   valid title and XP `120`, click **Add quest**: the form clears without errors.
5. Type `abc` into the XP box: Avalonia shows a conversion error on the box itself (quiz 8).

:::tip title="Break it on purpose"
Change `LoadAsync` to call `QuestSource.Generate(...)` directly instead of inside `Task.Run`, then
run again. The window freezes during the load and the progress bar jumps straight to 100 %. That's
the UI thread being blocked, and now you've seen it yourself. Change it back afterwards.
:::

- [ ] `dotnet build QuestBoard` succeeds with 0 errors
- [ ] `dotnet test QuestBoard.Tests` reports 7 passed, 0 failed
- [ ] The window stays responsive (draggable) while quests load, and Cancel stops the load
- [ ] Typing in the search box filters once after a pause, not on every key press
- [ ] Empty or too-short titles and out-of-range XP show messages next to the fields; a valid quest is added and the form resets
:::

:::info title="The same ideas in .NET MAUI"
Everything in the view models above works unchanged in MAUI. Only the view differs: `CollectionView`
instead of `ListBox`, `Entry` instead of `TextBox`, and a `Label` bound to `NewQuest.ErrorSummary`
for errors, since MAUI doesn't show `INotifyDataErrorInfo` errors by itself. To hop to the UI thread
from a background thread, use `MainThread.BeginInvokeOnMainThread(...)`. MAUI apps **can't be built
on Linux**: try this part on Windows (Visual Studio 2026) or macOS (`dotnet workload install maui`,
Xcode installed).
:::

:::cards id=dsk-08-cards1 xp=15 title="Async UI, lists & validation"
Q: What is the UI thread and why must slow work stay off it?
A: The single thread that runs the message loop: input, layout, rendering and your handlers. While one job blocks it, nothing else runs, so the window freezes.
Q: How do you run code on the UI thread from a background thread in Avalonia?
A: `Dispatcher.UIThread.Post(...)` (fire-and-forget) or `await Dispatcher.UIThread.InvokeAsync(...)`. Check with `Dispatcher.UIThread.CheckAccess()`.
Q: Why are you back on the UI thread after `await` in a view model?
A: The UI framework installs a SynchronizationContext on the UI thread, and `await` queues the continuation back to it (unless you use `ConfigureAwait(false)`).
Q: I/O-bound vs CPU-bound work: which tool for each?
A: I/O: the real async API (`ReadAllTextAsync`, `GetAsync`). CPU: `await Task.Run(() => …)` to use a thread-pool thread.
Q: Why does `.Result` on the UI thread deadlock?
A: It blocks the UI thread while the task waits to resume on that same UI thread, so neither can continue.
Q: What does `[RelayCommand(IncludeCancelCommand = true)]` on `async Task LoadAsync(CancellationToken ct)` generate?
A: `LoadCommand` (an `IAsyncRelayCommand` with `IsRunning`, disabled while running) and `LoadCancelCommand`, which cancels `ct`.
Q: How does cancellation work in .NET?
A: Cooperatively: a `CancellationTokenSource` cancels its token, and the work checks it (`ThrowIfCancellationRequested`) and throws `OperationCanceledException`, which you catch as "cancelled", not as an error.
Q: Why is `Progress<T>` safe to use from a worker thread?
A: It captures the SynchronizationContext where it's created, so callbacks run on the UI thread.
Q: What is debouncing?
A: Waiting until input has been quiet for X ms before acting, and cancelling the pending action on each new input. It saves work and avoids stale results.
Q: What is UI virtualization and what breaks it?
A: Creating controls only for visible rows and recycling them while scrolling. A parent that gives infinite height (StackPanel, ScrollViewer) breaks it.
Q: ObservableCollection vs assigning a new list?
A: ObservableCollection for small edits (one event per Add/Remove); a new list assigned to a property for bulk replacements (one notification).
Q: The three members of INotifyDataErrorInfo?
A: `HasErrors`, `GetErrors(propertyName)`, `ErrorsChanged`.
Q: `[NotifyDataErrorInfo]` vs `ValidateAllProperties()`?
A: The attribute validates a property each time it's set; `ValidateAllProperties()` validates every property, including untouched ones, and belongs in Save.
:::

## Recap

- One **UI thread** runs a message loop; block it and the window freezes. Touch UI from another
  thread and you get "Call from invalid thread". Use `Dispatcher.UIThread.Post`/`InvokeAsync` to hop
  back.
- `await` resumes on the UI thread thanks to the **SynchronizationContext**. Use real async APIs for
  I/O and `Task.Run` for CPU work. Never `.Result`/`.Wait()` on the UI thread, and avoid
  `async void`.
- `[RelayCommand]` on an `async Task` method creates an **AsyncRelayCommand**: `IsRunning`, no double
  runs, and `IncludeCancelCommand` for a cancel button. Catch expected exceptions inside.
- **Cancellation** is cooperative (`CancellationTokenSource` → token → `OperationCanceledException`).
  **`Progress<T>`** reports back on the UI thread. **Debounce** search by cancelling the previous
  delay.
- **Virtualization** builds only visible rows. Give lists bounded height (Grid `*` row, DockPanel
  fill), never a StackPanel or ScrollViewer parent. Use `DataGrid` for columns and sorting, and
  replace whole lists for bulk updates.
- **Validation:** DataAnnotations attributes define the rules, `INotifyDataErrorInfo` tells the view,
  and `ObservableValidator` wires it up. Validate live with `[NotifyDataErrorInfo]` and on submit with
  `ValidateAllProperties()`. Show clear messages next to fields. (On Avalonia 11, also remove its own
  DataAnnotations plugin, or every error shows twice.)
