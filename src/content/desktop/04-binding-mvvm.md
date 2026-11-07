---
id: dsk-05
title: Data Binding & MVVM
level: intermediate
minutes: 120
xp: 150
summary: Why MVVM exists, how bindings and change notification work, and how CommunityToolkit.Mvvm turns properties, commands and converters into a few attributes.
---

So far in XAML Isles you have placed controls on a window, set their properties directly, and used
`{Binding}`, `[ObservableProperty]` and `[RelayCommand]` as recipes (in **Your First Avalonia App**
and **Layout & Controls in XAML**). That works for a demo, but real apps change all the time: a list loads from the network, a button must
grey out while a form is invalid, a counter updates when you tick a box. This lesson is about the
machinery that keeps the screen and your data **in sync without you writing "update the label"
code everywhere**: data binding, change notification and the MVVM pattern.

Everything here works the same way in **Avalonia** and **.NET MAUI** (and in WPF/WinUI, where the
ideas were born). Where the two differ, the lesson says so.

:::info title="Words you'll meet in this lesson"
- **Code-behind** — the C# file paired with a XAML file (`MainWindow.axaml.cs`). Event handlers
  written there talk to controls directly.
- **Binding** — a link declared in XAML between a control property and a property of some object.
- **Source / target** — the *source* is the object holding the data (usually a ViewModel); the
  *target* is the control property showing it (`TextBlock.Text`).
- **Reflection** — looking up members *by name at runtime* (`"Title"` → the `Title` property).
  Flexible, but slower and invisible to the compiler.
- **Source generator** — a compiler plug-in that writes extra C# for you during the build.
- **Trimming / Native AOT** — publishing modes that strip unused code or compile ahead of time to
  native code. Both break code that relies on reflection, so "AOT-safe" means "no reflection needed".
:::

## Why MVVM?

Imagine QuestBoard without any pattern. The "Add" button's click handler in the window's
code-behind (`MainWindow.axaml.cs`) reads `TitleBox.Text`, creates a quest, adds a row to the
list, clears the box, recounts the open quests and sets `CounterLabel.Text`. Then the "tick"
checkbox handler recounts too. Then the "remove" handler. Soon:

- **The logic is glued to controls.** You can't test "adding a quest increments the counter"
  without starting a real window and clicking it.
- **The same update is repeated** in many handlers — forget one and the counter lies.
- **Designers and developers collide** in the same file.

**MVVM** (Model–View–ViewModel) splits that into three roles:

| Part | What it is | Knows about |
|---|---|---|
| **Model** | Your data and business rules (`Quest`, an API client, a repository). | Nothing about UI. |
| **ViewModel** | A plain C# class that holds the *state of one screen* (`NewTitle`, `Quests`, `RemainingText`) and the *actions* the user can take (`AddQuestCommand`). | The model. **Not** the view — no `Button`, no `TextBox`. |
| **View** | The XAML (`MainWindow.axaml`). Describes *what it looks like* and **binds** to ViewModel properties. | The ViewModel, only through bindings. |

The glue between View and ViewModel is **data binding**: a declaration in XAML that says "this
control property mirrors that ViewModel property". When the ViewModel changes, the binding updates
the control; when the user types, the binding updates the ViewModel. Your C# never touches a
control.

```xml
<!-- View: no event handlers, just declarations -->
<TextBlock Text="{Binding RemainingText}" />
<TextBox   Text="{Binding NewTitle}" />
<Button    Content="Add" Command="{Binding AddQuestCommand}" />
```

The payoff: the ViewModel is an ordinary class you can unit-test with `new MainViewModel()` —
which is exactly what the lab does.

:::job title="What you'll see at work"
Almost every XAML codebase (WPF, Avalonia, MAUI, WinUI) is MVVM. Code review will flag logic in
code-behind ("move this to the ViewModel"). The usual stack today is **CommunityToolkit.Mvvm**
(Microsoft's source-generator MVVM library). Older codebases use Prism, ReactiveUI or a homemade
`ViewModelBase` — the concepts below map one-to-one.
:::

:::quiz id=dsk-05-q1 xp=10
In MVVM, which statement about the ViewModel is true?
- [ ] It creates and positions the controls of the window.
- [x] It exposes state and commands for one screen and has no reference to any control.
- [ ] It is the same thing as the Model, just renamed.
- [ ] It must inherit from `Window` so bindings can find it.
> The ViewModel is a plain class with properties and commands. The View finds it through bindings (via
> the `DataContext`), so the ViewModel never needs a reference to a `Button` or `TextBox` — which is
> what makes it unit-testable.
:::

## The DataContext: where bindings look

A binding like `{Binding NewTitle}` only names a **path** — a property name. It still needs an
object to read `NewTitle` from. That object is the control's **DataContext** (in MAUI it is called
**BindingContext**).

The crucial rule is **DataContext inheritance**: if you set the DataContext on the window, every
child control inherits it unless it sets its own. So one assignment wires the whole screen:

```csharp
// App.axaml.cs (Avalonia template)
desktop.MainWindow = new MainWindow
{
    DataContext = new MainViewModel(),   // every control in the window now "sees" MainViewModel
};
```

```text
Window          DataContext = MainViewModel        (set explicitly)
 └ DockPanel    DataContext = MainViewModel        (inherited)
    ├ TextBox   DataContext = MainViewModel        (inherited)  → {Binding NewTitle}
    └ ListBox   DataContext = MainViewModel        (inherited)  → {Binding Quests}
       └ each row: DataContext = one QuestItemViewModel  (set by the ListBox for its items!)
```

The last line matters: an `ItemsControl`/`ListBox` sets **each generated row's DataContext to the
item it represents**. Inside an item template, `{Binding Title}` therefore means "the `Title` of
*this* quest", not of the window's ViewModel.

:::quiz id=dsk-05-q2 xp=10
The window's DataContext is `MainViewModel`. Inside the `ListBox.ItemTemplate`, a `TextBlock` has
`Text="{Binding Title}"`. Where does `Title` come from?
- [ ] `MainViewModel.Title`, because DataContext is always inherited from the window.
- [x] The `Title` of the item that row represents — the ListBox sets each row's DataContext to its item.
- [ ] Nowhere: bindings inside templates need an explicit `Source=`.
- [ ] The `TextBlock` itself.
> Inheritance flows down the tree *until something sets a new DataContext*. Items controls do exactly
> that for every row, so templates bind against the item (here a `QuestItemViewModel`).
:::

## Change notification: INotifyPropertyChanged

A binding reads the property once when it is created. How does it know when to **read again**?
The source object must **announce** changes. In .NET the announcement contract is the interface
`INotifyPropertyChanged` (INPC) from `System.ComponentModel`:

```csharp
public interface INotifyPropertyChanged
{
    event PropertyChangedEventHandler? PropertyChanged;   // "property X just changed"
}
```

A binding subscribes to `PropertyChanged`; when the event fires with the name it's bound to, it
re-reads the value and updates the control. Without the event, the screen silently goes stale.

### By hand first

Writing it yourself once shows there is no magic:

```csharp
using System.ComponentModel;
using System.Runtime.CompilerServices;

public class QuestItemViewModel : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    public string Title
    {
        get;                          // C# 14 'field' keyword: the compiler makes the backing field
        set
        {
            if (field == value) return;   // 1. no change → no event (avoids loops & wasted work)
            field = value;                // 2. store
            OnPropertyChanged();          // 3. announce "Title changed"
        }
    } = "";

    protected void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
```

Line by line:

- `field` (new in C# 14) is the compiler-generated backing field of the property. Before C# 14
  you wrote `private string _title = "";` and used `_title`.
- `[CallerMemberName]` makes the compiler fill in the calling member's name (`"Title"`), so you
  can't typo the string.
- `PropertyChanged?.Invoke(...)` raises the event only if someone subscribed (`?.` = "if not null").
- The equality check matters: two-way bindings write values back, and re-raising for an unchanged
  value can cause feedback loops.

**Dependent properties.** If `Label` is computed from `Title` (`public string Label => "⚔ " + Title;`),
nobody raises `Label` for you. The `Title` setter must also call `OnPropertyChanged(nameof(Label))`.
Forgetting this is the #1 "why doesn't my label update?" bug.

### With CommunityToolkit.Mvvm

Writing that setter for every property is boilerplate. **CommunityToolkit.Mvvm** (NuGet package
`CommunityToolkit.Mvvm`, version 8.x) ships `ObservableObject` (a base class implementing INPC) and
**source generators**: compiler plug-ins that *write the boring code for you at build time*, based
on attributes. The `avalonia.mvvm` template already references it.

```csharp
using CommunityToolkit.Mvvm.ComponentModel;

public partial class QuestItemViewModel : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Label))]      // also raise "Label" when Title changes
    public partial string Title { get; set; } = "";

    public string Label => "⚔ " + Title;

    // Optional hook the generator calls after the value changed:
    partial void OnTitleChanged(string value) => Console.WriteLine($"Renamed to {value}");
}
```

- The class and property are **`partial`**: you declare the property, the generator writes its
  body (the same equality-check-store-raise code as above) in another file.
- `[NotifyPropertyChangedFor]` handles dependent properties.
- `OnTitleChanging` / `OnTitleChanged` are optional partial methods you can implement for side
  effects.

:::info title="Field style vs. partial property style"
Older code (toolkit before 8.4, or projects on older C# versions) puts the attribute on a
**field** and the generator creates the property: `[ObservableProperty] private string _title = "";`
→ generates `Title`. On .NET 10 with toolkit 8.4+ the **partial property** style shown above is
preferred — it's what the current `avalonia.mvvm` template generates (`public partial string Greeting
{ get; set; }`). You write the real property yourself, so you can put any attribute or doc comment on
it, and it's the style the toolkit recommends for AOT scenarios. You'll meet both in real codebases.
:::

:::quiz id=dsk-05-q3 xp=10
A ViewModel has `public string FullName => $"{First} {Last}";`. `First` is an `[ObservableProperty]`.
The user edits the first name and a `TextBlock` bound to `FullName` doesn't change. Fix?
- [ ] Make the binding `Mode=TwoWay`.
- [x] Add `[NotifyPropertyChangedFor(nameof(FullName))]` to `First` (and `Last`).
- [ ] Turn `FullName` into an `ObservableCollection`.
- [ ] Call `InvalidateVisual()` on the TextBlock.
> The binding on `FullName` only re-reads when a `PropertyChanged` event says "FullName". A computed
> property never raises it by itself, so whatever changes its inputs must raise it too.
:::

Now build that core yourself — a tiny observable object in TypeScript, the same way INPC works.

:::challenge id=dsk-05-c1 lang=ts xp=40
title: An observable object
Finish `ObservableObject` so subclasses can announce changes, just like `INotifyPropertyChanged`:

- `subscribe(handler)` registers a handler called with the **property name** on every change, and
  returns a function that **unsubscribes** it.
- `setValue(name, value)` stores the value and returns `true`, raising `name` — but if the value
  is the same as the stored one (`Object.is`), it does **nothing** and returns `false`.
- `raise(name)` calls every handler with `name`.

`Quest` is already written: its setters use `setValue` and also raise the dependent `label` property
(that's `[NotifyPropertyChangedFor]` by hand).

hint: Keep handlers in an array; unsubscribe = filter the handler out.
hint: In `setValue`, compare with `Object.is(this.values[name], value)` before storing.
hint: Iterate over a copy (`[...this.handlers]`) so a handler that unsubscribes itself doesn't skip the next one.

```ts starter
type Handler = (propertyName: string) => void

export class ObservableObject {
  private handlers: Handler[] = []
  private values: Record<string, unknown> = {}

  subscribe(handler: Handler): () => void {
    // TODO: remember handler, return an unsubscribe function
    return () => {}
  }

  protected raise(name: string): void {
    // TODO: notify every handler
  }

  protected getValue<T>(name: string, fallback: T): T {
    return (name in this.values ? this.values[name] : fallback) as T
  }

  protected setValue(name: string, value: unknown): boolean {
    // TODO: skip unchanged values, store, raise
    this.values[name] = value
    return true
  }
}

export class Quest extends ObservableObject {
  get title(): string { return this.getValue('title', '') }
  set title(v: string) { if (this.setValue('title', v)) this.raise('label') }

  get isDone(): boolean { return this.getValue('isDone', false) }
  set isDone(v: boolean) { if (this.setValue('isDone', v)) this.raise('label') }

  get label(): string { return (this.isDone ? '[x] ' : '[ ] ') + this.title }
}
```

```ts solution
type Handler = (propertyName: string) => void

export class ObservableObject {
  private handlers: Handler[] = []
  private values: Record<string, unknown> = {}

  subscribe(handler: Handler): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  protected raise(name: string): void {
    for (const h of [...this.handlers]) h(name)
  }

  protected getValue<T>(name: string, fallback: T): T {
    return (name in this.values ? this.values[name] : fallback) as T
  }

  protected setValue(name: string, value: unknown): boolean {
    if (name in this.values && Object.is(this.values[name], value)) return false
    this.values[name] = value
    this.raise(name)
    return true
  }
}

export class Quest extends ObservableObject {
  get title(): string { return this.getValue('title', '') }
  set title(v: string) { if (this.setValue('title', v)) this.raise('label') }

  get isDone(): boolean { return this.getValue('isDone', false) }
  set isDone(v: boolean) { if (this.setValue('isDone', v)) this.raise('label') }

  get label(): string { return (this.isDone ? '[x] ' : '[ ] ') + this.title }
}
```

```ts tests
test('setting a property raises its name, then the dependent label', () => {
  const q = new Quest()
  const seen: string[] = []
  q.subscribe(n => seen.push(n))
  q.title = 'Slay the bug'
  expect(seen).toEqual(['title', 'label'])
  expect(q.label).toBe('[ ] Slay the bug')
})
test('setting the same value again raises nothing', () => {
  const q = new Quest()
  q.title = 'A'
  const seen: string[] = []
  q.subscribe(n => seen.push(n))
  q.title = 'A'
  expect(seen).toEqual([])
})
test('isDone change raises isDone and label', () => {
  const q = new Quest()
  q.title = 'Ship'
  const seen: string[] = []
  q.subscribe(n => seen.push(n))
  q.isDone = true
  expect(seen).toEqual(['isDone', 'label'])
  expect(q.label).toBe('[x] Ship')
})
test('every subscriber is notified', () => {
  const q = new Quest()
  const a = fn()
  const b = fn()
  q.subscribe(a)
  q.subscribe(b)
  q.title = 'X'
  expect(a).toHaveBeenCalledWith('title')
  expect(b).toHaveBeenCalledTimes(2)
})
test('unsubscribe stops notifications', () => {
  const q = new Quest()
  const h = fn()
  const off = q.subscribe(h)
  q.title = 'one'
  off()
  q.title = 'two'
  expect(h).toHaveBeenCalledTimes(2)
})
test('a handler may unsubscribe itself without skipping others', () => {
  const q = new Quest()
  const seen: string[] = []
  const off = q.subscribe(() => { seen.push('first'); off() })
  q.subscribe(n => seen.push('second:' + n))
  q.title = 'go'
  expect(seen).toEqual(['first', 'second:title', 'second:label'])
})
```
:::

## Bindings in XAML: syntax and modes

A binding is a **markup extension**. Normally an attribute value is a literal (`Text="Hello"`);
curly braces tell the XAML compiler "don't use this text as-is — create the object named inside the
braces and let it supply the value". `{Binding …}` creates a binding object:

```xml
<TextBox Text="{Binding NewTitle, Mode=TwoWay}" />
<!--     ↑ target property      ↑ path   ↑ options -->
```

- **Target**: the control property receiving the value (`Text`). It must be a bindable property
  (an `AvaloniaProperty` in Avalonia, a `BindableProperty` in MAUI) — almost every control
  property is.
- **Source**: the DataContext, unless you point the binding elsewhere: `Source=` (a specific
  object, e.g. a resource), `ElementName=` (another named control) or a *relative source* (an
  ancestor in the tree, such as the window that contains this control).
- **Path**: which property of the source, possibly nested: `{Binding SelectedQuest.Title}`.

The **binding mode** says which direction data flows:

| Mode | Direction | Typical use |
|---|---|---|
| `OneWay` | ViewModel → control, on every change | `TextBlock.Text`, `IsVisible`, most display properties |
| `TwoWay` | Both ways | `TextBox.Text`, `CheckBox.IsChecked`, `Slider.Value`, `ListBox.SelectedItem` |
| `OneTime` | ViewModel → control **once**, then never again | Values that never change (a version label); cheapest |
| `OneWayToSource` | Control → ViewModel only | Rare; e.g. report a control's state without pushing back |
| `Default` | Whatever the target property declares | What you get if you don't write `Mode=` |

You rarely write `Mode=`: input properties such as `TextBox.Text` and `CheckBox.IsChecked` default
to **TwoWay**, display properties default to **OneWay**. Write it when you want something else
(e.g. `OneTime` for a big static list).

:::warn title="When does TwoWay write back?"
Avalonia and MAUI push `TextBox`/`Entry` text into the ViewModel on **every keystroke**. Classic WPF
pushes `TextBox.Text` only when the box **loses focus** unless you add
`UpdateSourceTrigger=PropertyChanged`. If you move between XAML frameworks and a "Save" button's
`CanExecute` seems one step behind, this is why.
:::

Other options you'll meet: `StringFormat` (`{Binding Price, StringFormat='{}{0:C}'}`),
`FallbackValue` (used when the binding fails), `TargetNullValue` (used when the value is `null`),
`Converter` (below). Avalonia also has handy shortcuts such as `{Binding $parent[Window].Title}`
(walk up the tree) and `{Binding #TitleBox.Text}` (another named control).

:::quiz id=dsk-05-q4 xp=10
Your settings screen shows the app version, which never changes while the app runs. Which mode is the
best fit for `Text="{Binding AppVersion, Mode=…}"`?
- [ ] `TwoWay`
- [ ] `OneWayToSource`
- [x] `OneTime`
- [ ] `OneWay` is required because `TextBlock` can't use anything else.
> `OneTime` reads the value once and doesn't subscribe to change notification at all — the cheapest
> choice for values that are fixed. `TwoWay` makes no sense for a read-only label.
:::

## Compiled bindings and x:DataType

Classic bindings are **reflection bindings**: at runtime the framework looks up a property *by its
string name* on whatever object is in the DataContext. Typos (`{Binding RemainingTxt}`) don't fail
the build — they fail silently at runtime, with a log line nobody reads.

**Compiled bindings** fix that. You tell the XAML compiler the **type** of the DataContext with
`x:DataType`, and it turns each binding into generated, strongly typed code:

```xml
<Window xmlns:vm="using:QuestBoard.ViewModels"
        x:DataType="vm:MainViewModel">          <!-- "the DataContext here is a MainViewModel" -->
  <TextBlock Text="{Binding RemainingText}" />   <!-- checked at build time -->
</Window>
```

Benefits: **build errors instead of silent runtime failures**, faster (no reflection), and safe for
trimming / Native AOT. In Avalonia, the current `avalonia.mvvm` template turns compiled bindings on by
default (older 11.x projects set `<AvaloniaUseCompiledBindingsByDefault>true</AvaloniaUseCompiledBindingsByDefault>`
in the `.csproj`). In MAUI, setting `x:DataType` compiles the bindings beneath it.

Every **DataTemplate** declares its own type, because its DataContext is the item, not the window:

```xml
<ListBox ItemsSource="{Binding Quests}">
  <ListBox.ItemTemplate>
    <DataTemplate x:DataType="vm:QuestItemViewModel">
      <TextBlock Text="{Binding Title}" />
    </DataTemplate>
  </ListBox.ItemTemplate>
</ListBox>
```

:::tip title="Escape hatch"
If a spot genuinely can't be typed (truly dynamic data), Avalonia offers `{ReflectionBinding Path}`
and `x:CompileBindings="False"` for a subtree. Treat both as a code smell to justify in review.
:::

:::quiz id=dsk-05-q5 xp=10
What does adding `x:DataType="vm:MainViewModel"` to a view give you? (Select all that apply.)
- [x] Misspelled binding paths become build errors.
- [x] Bindings run without runtime reflection, so they're faster and trimming/AOT-friendly.
- [ ] It sets the DataContext to a new `MainViewModel` at runtime.
- [x] Editors with XAML support (Rider, the Avalonia/MAUI extensions) can complete and navigate binding paths, because the type is known.
> `x:DataType` is a promise about the DataContext's *type* so the compiler can check and generate
> code. It does **not** create or assign the object — you still set `DataContext` (or MAUI's
> `BindingContext`) in code or via DI.
:::

## Collections: ObservableCollection<T>

INPC announces "property X changed". But when you `Add` to a `List<Quest>`, the `Quests` *property*
still points to the same list — no property changed, so the `ListBox` never hears about the new item.

`ObservableCollection<T>` (in `System.Collections.ObjectModel`) is a list that implements
**`INotifyCollectionChanged`**: it raises `CollectionChanged` with "added item at index 3",
"removed item", "reset". Items controls subscribe and add/remove just that row.

```csharp
public ObservableCollection<QuestItemViewModel> Quests { get; } = new();
// later:
Quests.Add(new QuestItemViewModel("Learn bindings"));   // ListBox shows a new row immediately
```

Two things it does **not** do:

1. It does **not** tell you when a property *of an item* changes (`Quests[0].IsDone = true`).
   The row updates (it binds to the item's own INPC), but a counter like "3 quests left" on the
   ViewModel needs you to listen to each item's `PropertyChanged` — the lab shows how.
2. Replacing the whole collection (`Quests = new(...)`) is a *property* change: the property then
   needs INPC too. Prefer a get-only collection you `Clear()` and refill, or make it an
   `[ObservableProperty]`.

:::warn title="UI thread"
Controls may only be touched on the UI thread, and that includes `CollectionChanged`/`PropertyChanged`
events that a binding reacts to. After `await`-ing an HTTP call from a UI event you're usually back on
the UI thread already; from a background thread/timer, marshal with
`Dispatcher.UIThread.Post(...)` (Avalonia) or `MainThread.BeginInvokeOnMainThread(...)` (MAUI).
:::

:::quiz id=dsk-05-q6 xp=10
`public List<Quest> Quests { get; } = new();` is bound to a `ListBox`. After `Quests.Add(q)` the list
on screen doesn't change. Why?
- [ ] `ListBox` can only show strings.
- [ ] `Add` must be called inside `OnPropertyChanged`.
- [x] `List<T>` raises no `CollectionChanged` event, so the ListBox doesn't know an item was added — use `ObservableCollection<T>`.
- [ ] The binding must be `TwoWay`.
> Bindings react to events. `List<T>` raises none; `ObservableCollection<T>` raises
> `INotifyCollectionChanged.CollectionChanged` for every add/remove/move/reset.
:::

## Commands and CanExecute

Buttons, menu items and key bindings don't call ViewModel methods directly — they bind to a
**command**: an object implementing `System.Windows.Input.ICommand`:

```csharp
public interface ICommand
{
    bool CanExecute(object? parameter);   // "may I run right now?"  → button enabled/disabled
    void Execute(object? parameter);      // "run"                   → button clicked
    event EventHandler? CanExecuteChanged; // "ask CanExecute again"
}
```

The button calls `CanExecute` when it binds and **again every time `CanExecuteChanged` fires**,
enabling or disabling itself. That event is the part people forget: if the ViewModel's state changes
but nobody raises `CanExecuteChanged`, the button stays stuck in its old state.

The toolkit generates commands from methods:

```csharp
public partial class MainViewModel : ObservableObject
{
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]   // NewTitle changes → re-ask CanExecute
    public partial string NewTitle { get; set; } = "";

    [RelayCommand(CanExecute = nameof(CanAddQuest))]        // generates AddQuestCommand
    private void AddQuest() { /* ... */ }

    private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewTitle);
}
```

- `[RelayCommand]` on `AddQuest()` generates a property **`AddQuestCommand`** (method name +
  `Command`) of type `IRelayCommand`.
- A method with a parameter, `void Remove(QuestItemViewModel q)`, becomes `RelayCommand<QuestItemViewModel>`;
  the XAML passes the argument with `CommandParameter="{Binding}"`.
- An `async Task` method becomes an `IAsyncRelayCommand`: it exposes `IsRunning` and, by default,
  reports `CanExecute = false` while running — a free "no double submit".
- `[NotifyCanExecuteChangedFor]` raises `CanExecuteChanged` whenever the property changes. You can
  also call `AddQuestCommand.NotifyCanExecuteChanged()` yourself.

XAML: `<Button Content="Add" Command="{Binding AddQuestCommand}" />` — no click handler.

:::quiz id=dsk-05-q7 xp=10
"Save" is bound to `SaveCommand` with `CanExecute = nameof(CanSave)`, where `CanSave()` checks that
`Email` is not empty. Typing an email doesn't enable the button. What's missing?
- [ ] `Mode=TwoWay` on the button's `Command` binding.
- [x] Nothing raises `CanExecuteChanged` when `Email` changes — add `[NotifyCanExecuteChangedFor(nameof(SaveCommand))]` to `Email`.
- [ ] `CanSave` must be `public`.
- [ ] Buttons only check `CanExecute` once, so use `IsEnabled` instead.
> The button re-evaluates `CanExecute` only when the command raises `CanExecuteChanged`. The toolkit
> raises it for you when you tell it which properties affect which commands.
:::

:::challenge id=dsk-05-c2 lang=ts xp=45
title: RelayCommand with CanExecute
Implement a `RelayCommand` like the toolkit's, then wire it up in a ViewModel:

- `canExecute()` returns the result of the optional `canExecute` function (default: always `true`).
- `execute()` runs the action **only if** `canExecute()` is true.
- `onCanExecuteChanged(listener)` registers a listener and returns an unsubscribe function.
- `notifyCanExecuteChanged()` calls every listener.

In `AddQuestViewModel`, setting `newTitle` must call `addQuestCommand.notifyCanExecuteChanged()` —
that's what `[NotifyCanExecuteChangedFor]` generates. The tests simulate a button that re-reads
`canExecute()` whenever it's told to.

hint: Store the two functions in fields in the constructor.
hint: The `newTitle` setter: store the value, then notify the command.

```ts starter
type Listener = () => void

export class RelayCommand {
  private run: () => void
  private can: () => boolean
  private listeners: Listener[] = []

  constructor(execute: () => void, canExecute: () => boolean = () => true) {
    this.run = execute
    this.can = canExecute
  }

  canExecute(): boolean {
    return true // TODO
  }

  execute(): void {
    this.run() // TODO: only when allowed
  }

  onCanExecuteChanged(listener: Listener): () => void {
    return () => {} // TODO
  }

  notifyCanExecuteChanged(): void {
    // TODO
  }
}

export class AddQuestViewModel {
  quests: string[] = []
  private title = ''
  addQuestCommand: RelayCommand

  constructor() {
    this.addQuestCommand = new RelayCommand(
      () => this.addQuest(),
      () => this.newTitle.trim() !== '',
    )
  }

  get newTitle(): string { return this.title }
  set newTitle(v: string) {
    this.title = v
    // TODO: tell the command to re-evaluate
  }

  private addQuest(): void {
    this.quests.push(this.newTitle.trim())
    this.newTitle = ''
  }
}
```

```ts solution
type Listener = () => void

export class RelayCommand {
  private run: () => void
  private can: () => boolean
  private listeners: Listener[] = []

  constructor(execute: () => void, canExecute: () => boolean = () => true) {
    this.run = execute
    this.can = canExecute
  }

  canExecute(): boolean {
    return this.can()
  }

  execute(): void {
    if (this.canExecute()) this.run()
  }

  onCanExecuteChanged(listener: Listener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  notifyCanExecuteChanged(): void {
    for (const l of [...this.listeners]) l()
  }
}

export class AddQuestViewModel {
  quests: string[] = []
  private title = ''
  addQuestCommand: RelayCommand

  constructor() {
    this.addQuestCommand = new RelayCommand(
      () => this.addQuest(),
      () => this.newTitle.trim() !== '',
    )
  }

  get newTitle(): string { return this.title }
  set newTitle(v: string) {
    this.title = v
    this.addQuestCommand.notifyCanExecuteChanged()
  }

  private addQuest(): void {
    this.quests.push(this.newTitle.trim())
    this.newTitle = ''
  }
}
```

```ts tests
function fakeButton(cmd: RelayCommand) {
  const button = { enabled: cmd.canExecute() }
  cmd.onCanExecuteChanged(() => { button.enabled = cmd.canExecute() })
  return button
}
test('a command without canExecute is always enabled', () => {
  const run = fn()
  const cmd = new RelayCommand(run)
  expect(cmd.canExecute()).toBe(true)
  cmd.execute()
  expect(run).toHaveBeenCalledTimes(1)
})
test('canExecute uses the supplied function', () => {
  let allowed = false
  const cmd = new RelayCommand(() => {}, () => allowed)
  expect(cmd.canExecute()).toBe(false)
  allowed = true
  expect(cmd.canExecute()).toBe(true)
})
test('execute does nothing while canExecute is false', () => {
  const run = fn()
  const cmd = new RelayCommand(run, () => false)
  cmd.execute()
  expect(run).not.toHaveBeenCalled()
})
test('listeners can unsubscribe', () => {
  const cmd = new RelayCommand(() => {})
  const l = fn()
  const off = cmd.onCanExecuteChanged(l)
  cmd.notifyCanExecuteChanged()
  off()
  cmd.notifyCanExecuteChanged()
  expect(l).toHaveBeenCalledTimes(1)
})
test('the Add button starts disabled and enables when a title is typed', () => {
  const vm = new AddQuestViewModel()
  const button = fakeButton(vm.addQuestCommand)
  expect(button.enabled).toBe(false)
  vm.newTitle = '   '
  expect(button.enabled).toBe(false)
  vm.newTitle = 'Learn MVVM'
  expect(button.enabled).toBe(true)
})
test('running Add stores the trimmed title, clears the box and disables the button again', () => {
  const vm = new AddQuestViewModel()
  const button = fakeButton(vm.addQuestCommand)
  vm.addQuestCommand.execute()
  expect(vm.quests).toEqual([])
  vm.newTitle = '  Ship it '
  vm.addQuestCommand.execute()
  expect(vm.quests).toEqual(['Ship it'])
  expect(vm.newTitle).toBe('')
  expect(button.enabled).toBe(false)
})
```
:::

## Value converters

Sometimes the ViewModel's type isn't what the control wants: a `bool IsDone` but the control wants
an `Opacity` (`double`); an `int Minutes` but you want to show `"1h 30m"`. A **value converter**
translates between them in the binding, keeping the ViewModel free of UI types like brushes.

```csharp
using System.Globalization;
using Avalonia.Data.Converters;   // MAUI: Microsoft.Maui.Controls (same interface shape)

public class DoneToOpacityConverter : IValueConverter
{
    // source (ViewModel) → target (control)
    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is true ? 0.45 : 1.0;

    // target → source; only needed for TwoWay bindings
    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
```

Use it by declaring an instance as a **resource** and referencing it with `StaticResource`:

```xml
<Window.Resources>
  <conv:DoneToOpacityConverter x:Key="DoneToOpacity" />
</Window.Resources>
...
<TextBlock Opacity="{Binding IsDone, Converter={StaticResource DoneToOpacity}}" />
```

- `parameter` receives `ConverterParameter=...` from XAML, so one converter can be configurable.
- For TwoWay bindings, `ConvertBack` turns user input back into the ViewModel type. When input
  is invalid, don't throw: in Avalonia return `BindingOperations.DoNothing` (leave the source
  unchanged) or a `BindingNotification` with an error.
- Built-ins save you writing trivial ones: Avalonia has `BoolConverters.Not`,
  `ObjectConverters.IsNotNull`, `StringConverters.IsNullOrEmpty`, and you can often bind
  `IsVisible="{Binding !IsBusy}"` (the `!` negation shortcut). MAUI's Community Toolkit offers
  `InvertedBoolConverter` and friends.

:::pro title="Converter or ViewModel property?"
If the conversion is *presentation* (bool → colour, enum → icon), a converter keeps UI types out of the
ViewModel. If it's *logic* you want to test or reuse ("is this quest overdue?"), compute it as a
ViewModel property instead. Seniors also avoid "converter soup" — five chained converters is a sign a
ViewModel property is missing.
:::

:::challenge id=dsk-05-c3 lang=ts xp=40
title: A two-way duration converter
Write `minutesConverter`, a two-way converter for a quest's estimate:

- `convert(minutes)` → text: `0` → `"0m"`, `45` → `"45m"`, `60` → `"1h"`, `90` → `"1h 30m"`.
- `convertBack(text)` → minutes. Accept `"1h 30m"`, `"1h30m"`, `"2h"`, `"45m"`, a bare number
  `"90"` (= minutes), surrounding spaces and any letter case (`" 2H "`).
  For anything else (`""`, `"abc"`, `"1x"`) return `DO_NOTHING` — like Avalonia's
  `BindingOperations.DoNothing`, it means "leave the ViewModel value unchanged".

`DO_NOTHING` and the `ValueConverter` type are provided in the setup code.

hint: `Math.floor(m / 60)` hours, `m % 60` minutes; leave out the parts that are zero (except for 0 itself).
hint: For parsing, a regex like `/^(?:(\d+)h)?\s*(?:(\d+)m)?$/i` on the trimmed, non-empty text — but check that at least one group matched.

```ts setup
export const DO_NOTHING = Symbol('DoNothing')
export interface ValueConverter<TSource, TTarget> {
  convert(value: TSource): TTarget
  convertBack(value: TTarget): TSource | typeof DO_NOTHING
}
```

```ts starter
export const minutesConverter: ValueConverter<number, string> = {
  convert(minutes) {
    return `${minutes}m`
  },
  convertBack(text) {
    return DO_NOTHING
  },
}
```

```ts solution
export const minutesConverter: ValueConverter<number, string> = {
  convert(minutes) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    if (h === 0) return `${m}m`
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  },
  convertBack(text) {
    const t = text.trim()
    if (/^\d+$/.test(t)) return Number(t)
    const match = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/i.exec(t)
    if (!t || !match || (match[1] === undefined && match[2] === undefined)) return DO_NOTHING
    return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
  },
}
```

```ts tests
test('convert formats minutes', () => {
  expect(minutesConverter.convert(0)).toBe('0m')
  expect(minutesConverter.convert(45)).toBe('45m')
  expect(minutesConverter.convert(60)).toBe('1h')
  expect(minutesConverter.convert(90)).toBe('1h 30m')
  expect(minutesConverter.convert(125)).toBe('2h 5m')
})
test('convertBack parses hours and minutes', () => {
  expect(minutesConverter.convertBack('1h 30m')).toBe(90)
  expect(minutesConverter.convertBack('1h30m')).toBe(90)
  expect(minutesConverter.convertBack('2h')).toBe(120)
  expect(minutesConverter.convertBack('45m')).toBe(45)
})
test('convertBack accepts bare numbers, spaces and any case', () => {
  expect(minutesConverter.convertBack('90')).toBe(90)
  expect(minutesConverter.convertBack(' 2H ')).toBe(120)
  expect(minutesConverter.convertBack('1H 5M')).toBe(65)
})
test('invalid input leaves the source alone', () => {
  expect(minutesConverter.convertBack('')).toBe(DO_NOTHING)
  expect(minutesConverter.convertBack('   ')).toBe(DO_NOTHING)
  expect(minutesConverter.convertBack('abc')).toBe(DO_NOTHING)
  expect(minutesConverter.convertBack('1x')).toBe(DO_NOTHING)
})
test('round trip: convertBack(convert(x)) === x', () => {
  for (const x of [0, 5, 60, 61, 125, 600]) {
    expect(minutesConverter.convertBack(minutesConverter.convert(x))).toBe(x)
  }
})
```
:::

## Design-time data

The XAML previewer in your IDE (Avalonia for Rider/VS/VS Code; MAUI has XAML Hot Reload instead of
a designer) renders the view **without running `App.axaml.cs`**, so the real DataContext is
never set. Design-time data gives the previewer something to show:

```xml
<Window xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
        xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
        mc:Ignorable="d" d:DesignWidth="480" d:DesignHeight="560"
        x:DataType="vm:MainViewModel">
  <Design.DataContext>
    <vm:MainViewModel />   <!-- previewer only; ignored when the app runs -->
  </Design.DataContext>
```

- `Design.DataContext` (Avalonia) is applied **only in the previewer**. At runtime it does nothing —
  you still assign the real DataContext.
- `d:` attributes (`d:DesignWidth`) are design-only too; `mc:Ignorable="d"` tells the runtime to
  skip them.
- For the previewer to construct your ViewModel it needs a **parameterless constructor**. When the
  real one takes services (`MainViewModel(IQuestApi api)`), add a small `DesignMainViewModel`
  subclass with fake data.

:::quiz id=dsk-05-q8 xp=10
A teammate removes `DataContext = new MainViewModel()` from `App.axaml.cs` because "the window already
has `<Design.DataContext>`". What happens when the app runs?
- [ ] Nothing changes; `Design.DataContext` is used when no other DataContext is set.
- [x] The window has no DataContext at runtime, so every binding resolves to nothing and the screen is empty.
- [ ] The build fails because `x:DataType` requires a runtime DataContext.
- [ ] The app crashes with a `NullReferenceException` at startup.
> Design-time data is only for the IDE previewer. Compiled bindings still build fine (the *type* is
> known), but at runtime there's no object to read from: bindings produce their fallback/default values.
:::

## Common binding errors and how to read them

Binding failures rarely crash the app — they **log and carry on**, which is why they hide. Learn
the usual suspects:

| Symptom | Usual cause | Fix |
|---|---|---|
| Build error `AVLN2000: Unable to resolve property or method of name 'RemainingTxt' on type 'QuestBoard.ViewModels.MainViewModel'` | Typo in a **compiled** binding path (good: caught at build time). | Fix the name; the message tells you file, line and the type it searched. |
| Value shows once, never updates | Property doesn't raise `PropertyChanged` (or a dependent property isn't notified). | `[ObservableProperty]` / `[NotifyPropertyChangedFor]`. |
| List never shows new items | `List<T>` instead of `ObservableCollection<T>`. | Use `ObservableCollection<T>`. |
| Button stuck disabled/enabled | `CanExecuteChanged` never raised. | `[NotifyCanExecuteChangedFor]` or `NotifyCanExecuteChanged()`. |
| Everything blank | DataContext not set, or set to the wrong type. | Check `App.axaml.cs` / navigation code; inspect with DevTools. |
| Binding inside a template can't find the window's command | Template DataContext is the **item**. | Bind via the parent: `{Binding $parent[ListBox].((vm:MainViewModel)DataContext).RemoveCommand}` in Avalonia, or move the command onto the item ViewModel. |
| Error only with reflection bindings, at runtime | Same typo, but `x:DataType` missing. | Add `x:DataType` so it becomes a build error. |

**Reading a runtime binding log.** With reflection bindings, Avalonia writes warnings through its
logger (the template's `.LogToTrace()` sends them to the IDE's debug output) in the `Binding` area. They
look roughly like:

```text
[Binding] An error occurred binding 'Text' to 'RemainingTxt' at 'RemainingTxt':
          'Could not find a matching property accessor for 'RemainingTxt' on 'QuestBoard.ViewModels.MainViewModel''
```

Read it as: **target property** (`Text`) → **path** (`RemainingTxt`) → **where it broke** →
**on which source type**. If the source type is not what you expected (e.g. it says
`QuestItemViewModel` when you meant `MainViewModel`), the problem is the DataContext, not the name.
MAUI's equivalent appears in the debug output as a "Binding: 'X' property not found on 'Y'" message.

:::tip title="Avalonia Developer Tools"
In a Debug build, press **F12** in the running app to inspect the visual tree, each control's
DataContext and its property values (one-time setup in **Your First Avalonia App**). It's the fastest
way to answer "what is this control actually bound to?". If F12 does nothing, the separate Developer
Tools app isn't installed yet; the rest of this lesson works without it.
:::

:::quiz id=dsk-05-q9 xp=10
A runtime log says: *binding 'Text' to 'DueDate' … could not find a matching property accessor for
'DueDate' on 'QuestBoard.ViewModels.MainViewModel'*. The `TextBlock` is inside the quest item template
and `DueDate` exists on `QuestItemViewModel`. What's the most likely cause?
- [ ] `DueDate` is a `DateTime`, which can't be bound.
- [x] The template's binding is resolving against the window's ViewModel — the template's DataContext/`x:DataType` is wrong (e.g. the binding sits outside the `DataTemplate`, or the control is not inside an items control).
- [ ] `Mode=OneTime` is required for dates.
- [ ] The log is harmless; it always appears on startup.
> The log names the source type it searched. It searched `MainViewModel`, not `QuestItemViewModel`, so
> the DataContext at that point isn't the item. Fix the template/DataContext rather than the property name.
:::

## Testing ViewModels

Because a ViewModel is plain code, its tests are plain unit tests: create it, set properties,
execute commands, assert on state **and on notifications**. Asserting that `PropertyChanged` fires
is what catches the "UI doesn't update" bugs before a human sees them.

:::challenge id=dsk-05-c4 lang=ts mode=tests xp=50
title: Write the tests for a QuestList ViewModel
Below is a small ViewModel (a TypeScript stand-in for a C# one). `changes` records every
notification it raises (like `PropertyChanged` names). Write tests that **pass** against it and
**catch every buggy version** (mutants): someone forgetting to trim, forgetting to clear the box,
allowing blank titles, counting the wrong quests, or not notifying `remaining`.

```ts impl
export class QuestListVm {
  quests: { title: string; done: boolean }[] = []
  newTitle = ''
  changes: string[] = []

  get canAdd(): boolean {
    return this.newTitle.trim().length > 0
  }

  add(): void {
    if (!this.canAdd) return
    this.quests.push({ title: this.newTitle.trim(), done: false })
    this.newTitle = ''
    this.changes.push('quests', 'remaining')
  }

  toggle(index: number): void {
    this.quests[index].done = !this.quests[index].done
    this.changes.push('remaining')
  }

  get remaining(): number {
    return this.quests.filter(q => !q.done).length
  }
}
```

```ts mutant
export class QuestListVm {
  quests: { title: string; done: boolean }[] = []
  newTitle = ''
  changes: string[] = []
  get canAdd(): boolean { return this.newTitle.trim().length > 0 }
  add(): void {
    if (!this.canAdd) return
    this.quests.push({ title: this.newTitle, done: false })
    this.newTitle = ''
    this.changes.push('quests', 'remaining')
  }
  toggle(index: number): void { this.quests[index].done = !this.quests[index].done; this.changes.push('remaining') }
  get remaining(): number { return this.quests.filter(q => !q.done).length }
}
```

```ts mutant
export class QuestListVm {
  quests: { title: string; done: boolean }[] = []
  newTitle = ''
  changes: string[] = []
  get canAdd(): boolean { return this.newTitle.length > 0 }
  add(): void {
    if (!this.canAdd) return
    this.quests.push({ title: this.newTitle.trim(), done: false })
    this.newTitle = ''
    this.changes.push('quests', 'remaining')
  }
  toggle(index: number): void { this.quests[index].done = !this.quests[index].done; this.changes.push('remaining') }
  get remaining(): number { return this.quests.filter(q => !q.done).length }
}
```

```ts mutant
export class QuestListVm {
  quests: { title: string; done: boolean }[] = []
  newTitle = ''
  changes: string[] = []
  get canAdd(): boolean { return this.newTitle.trim().length > 0 }
  add(): void {
    if (!this.canAdd) return
    this.quests.push({ title: this.newTitle.trim(), done: false })
    this.changes.push('quests', 'remaining')
  }
  toggle(index: number): void { this.quests[index].done = !this.quests[index].done; this.changes.push('remaining') }
  get remaining(): number { return this.quests.filter(q => !q.done).length }
}
```

```ts mutant
export class QuestListVm {
  quests: { title: string; done: boolean }[] = []
  newTitle = ''
  changes: string[] = []
  get canAdd(): boolean { return this.newTitle.trim().length > 0 }
  add(): void {
    if (!this.canAdd) return
    this.quests.push({ title: this.newTitle.trim(), done: false })
    this.newTitle = ''
    this.changes.push('quests', 'remaining')
  }
  toggle(index: number): void { this.quests[index].done = !this.quests[index].done }
  get remaining(): number { return this.quests.filter(q => !q.done).length }
}
```

```ts mutant
export class QuestListVm {
  quests: { title: string; done: boolean }[] = []
  newTitle = ''
  changes: string[] = []
  get canAdd(): boolean { return this.newTitle.trim().length > 0 }
  add(): void {
    if (!this.canAdd) return
    this.quests.push({ title: this.newTitle.trim(), done: false })
    this.newTitle = ''
    this.changes.push('quests', 'remaining')
  }
  toggle(index: number): void { this.quests[index].done = !this.quests[index].done; this.changes.push('remaining') }
  get remaining(): number { return this.quests.filter(q => q.done).length }
}
```

```ts starter
test('adding a quest', () => {
  const vm = new QuestListVm()
  vm.newTitle = 'Learn bindings'
  vm.add()
  // expect(...)
})
```

```ts solution
test('add stores a trimmed title and clears the box', () => {
  const vm = new QuestListVm()
  vm.newTitle = '  Learn bindings  '
  vm.add()
  expect(vm.quests).toEqual([{ title: 'Learn bindings', done: false }])
  expect(vm.newTitle).toBe('')
})
test('blank titles cannot be added', () => {
  const vm = new QuestListVm()
  vm.newTitle = '   '
  expect(vm.canAdd).toBe(false)
  vm.add()
  expect(vm.quests).toHaveLength(0)
})
test('remaining counts open quests', () => {
  const vm = new QuestListVm()
  vm.newTitle = 'a'; vm.add()
  vm.newTitle = 'b'; vm.add()
  vm.newTitle = 'c'; vm.add()
  vm.toggle(0)
  expect(vm.remaining).toBe(2)
})
test('toggle notifies remaining', () => {
  const vm = new QuestListVm()
  vm.newTitle = 'a'; vm.add()
  vm.changes = []
  vm.toggle(0)
  expect(vm.changes).toContain('remaining')
})
```
:::

:::lab id=dsk-05-lab1 xp=100
title: QuestBoard MVVM
Build the QuestBoard screen with real MVVM in Avalonia: a ViewModel per quest, an
`ObservableCollection`, two commands with `CanExecute`, a computed "quests left" counter, a value
converter, compiled bindings, design-time data — and xUnit tests for the ViewModel.
Works on Linux, macOS and Windows with the **.NET 10 SDK**.

**1. Create the solution**

```bash
dotnet new install Avalonia.Templates
dotnet new avalonia.mvvm -o QuestBoard
dotnet new xunit -o QuestBoard.Tests
dotnet add QuestBoard.Tests reference QuestBoard
dotnet new sln -n QuestBoard
dotnet sln add QuestBoard/QuestBoard.csproj QuestBoard.Tests/QuestBoard.Tests.csproj
rm QuestBoard.Tests/UnitTest1.cs
mkdir QuestBoard/Converters
```

The template gives you `ViewModels/ViewModelBase.cs` (an `ObservableObject`), a `MainViewModel`,
`Views/MainWindow.axaml`, and `App.axaml.cs`, which sets `DataContext = new MainViewModel()`. It
references the current Avalonia release and `CommunityToolkit.Mvvm` 8.x. (The code below was built and
tested with the template's packages as of November 2026 — Avalonia 12.1.5 and CommunityToolkit.Mvvm
8.4.2 on the .NET 10 SDK. It also works on an Avalonia 11.x project — there, use `Watermark` instead of
`PlaceholderText`, and make sure the `.csproj` contains
`<AvaloniaUseCompiledBindingsByDefault>true</AvaloniaUseCompiledBindingsByDefault>`.)

:::info
On Windows PowerShell, use `del QuestBoard.Tests\UnitTest1.cs` instead of `rm`. Recent SDKs
create a `QuestBoard.slnx` file (the new XML solution format); older ones create `QuestBoard.sln`.
Both work the same.
:::

**2. One ViewModel per quest** — `QuestBoard/ViewModels/QuestItemViewModel.cs`

```csharp
using CommunityToolkit.Mvvm.ComponentModel;

namespace QuestBoard.ViewModels;

public partial class QuestItemViewModel : ViewModelBase
{
    public QuestItemViewModel(string title) => Title = title;

    [ObservableProperty]
    public partial string Title { get; set; }

    [ObservableProperty]
    public partial bool IsDone { get; set; }
}
```

**3. The screen's ViewModel** — replace `QuestBoard/ViewModels/MainViewModel.cs`

```csharp
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace QuestBoard.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    public MainViewModel()
    {
        Quests.CollectionChanged += OnQuestsChanged;
        Quests.Add(new QuestItemViewModel("Read the binding lesson"));
        Quests.Add(new QuestItemViewModel("Build QuestBoard") { IsDone = true });
    }

    public ObservableCollection<QuestItemViewModel> Quests { get; } = new();

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]
    public partial string NewTitle { get; set; } = "";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(RemoveSelectedCommand))]
    public partial QuestItemViewModel? SelectedQuest { get; set; }

    public int RemainingCount => Quests.Count(q => !q.IsDone);

    public string RemainingText => RemainingCount == 1 ? "1 quest left" : $"{RemainingCount} quests left";

    [RelayCommand(CanExecute = nameof(CanAddQuest))]
    private void AddQuest()
    {
        Quests.Add(new QuestItemViewModel(NewTitle.Trim()));
        NewTitle = "";
    }

    private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewTitle);

    [RelayCommand(CanExecute = nameof(CanRemoveSelected))]
    private void RemoveSelected()
    {
        if (SelectedQuest is { } quest)
            Quests.Remove(quest);
    }

    private bool CanRemoveSelected() => SelectedQuest is not null;

    // ObservableCollection only reports adds/removes. To react when a quest's IsDone
    // flips, listen to every item's PropertyChanged as well.
    private void OnQuestsChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.OldItems is not null)
            foreach (QuestItemViewModel q in e.OldItems) q.PropertyChanged -= OnQuestPropertyChanged;
        if (e.NewItems is not null)
            foreach (QuestItemViewModel q in e.NewItems) q.PropertyChanged += OnQuestPropertyChanged;
        RaiseRemainingChanged();
    }

    private void OnQuestPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(QuestItemViewModel.IsDone))
            RaiseRemainingChanged();
    }

    private void RaiseRemainingChanged()
    {
        OnPropertyChanged(nameof(RemainingCount));
        OnPropertyChanged(nameof(RemainingText));
    }
}
```

Notice what's **not** here: no `TextBox`, no `Button`, no `using Avalonia`. Removing a quest also
unsubscribes from it, so removed ViewModels don't leak or keep updating the counter.

**4. A converter** — `QuestBoard/Converters/DoneToOpacityConverter.cs`

```csharp
using System;
using System.Globalization;
using Avalonia.Data.Converters;

namespace QuestBoard.Converters;

/// <summary>bool IsDone → Opacity: finished quests fade to 0.45.</summary>
public class DoneToOpacityConverter : IValueConverter
{
    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is true ? 0.45 : 1.0;

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException("Opacity never flows back to IsDone.");
}
```

**5. The view** — replace `QuestBoard/Views/MainWindow.axaml`

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.ViewModels"
        xmlns:conv="using:QuestBoard.Converters"
        xmlns:d="http://schemas.microsoft.com/expression/blend/2008"
        xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
        mc:Ignorable="d" d:DesignWidth="480" d:DesignHeight="560"
        x:Class="QuestBoard.Views.MainWindow"
        x:DataType="vm:MainViewModel"
        Icon="/Assets/avalonia-logo.ico"
        Width="480" Height="560"
        Title="QuestBoard">

    <Design.DataContext>
        <vm:MainViewModel />
    </Design.DataContext>

    <Window.Resources>
        <conv:DoneToOpacityConverter x:Key="DoneToOpacity" />
    </Window.Resources>

    <DockPanel Margin="16">
        <TextBlock DockPanel.Dock="Top" FontSize="20" Margin="0,0,0,12"
                   Text="{Binding RemainingText}" />

        <Grid DockPanel.Dock="Top" ColumnDefinitions="*,Auto" Margin="0,0,0,12">
            <TextBox Text="{Binding NewTitle}" PlaceholderText="New quest..." />
            <Button Grid.Column="1" Margin="8,0,0,0" IsDefault="True"
                    Content="Add" Command="{Binding AddQuestCommand}" />
        </Grid>

        <Button DockPanel.Dock="Bottom" Margin="0,12,0,0" HorizontalAlignment="Right"
                Content="Remove selected" Command="{Binding RemoveSelectedCommand}" />

        <ListBox ItemsSource="{Binding Quests}" SelectedItem="{Binding SelectedQuest}">
            <ListBox.ItemTemplate>
                <DataTemplate x:DataType="vm:QuestItemViewModel">
                    <StackPanel Orientation="Horizontal" Spacing="8">
                        <CheckBox IsChecked="{Binding IsDone}" />
                        <TextBlock VerticalAlignment="Center" Text="{Binding Title}"
                                   Opacity="{Binding IsDone, Converter={StaticResource DoneToOpacity}}" />
                    </StackPanel>
                </DataTemplate>
            </ListBox.ItemTemplate>
        </ListBox>
    </DockPanel>
</Window>
```

Leave `App.axaml.cs`, `MainWindow.axaml.cs` and the other template files as they are.

**6. Tests** — `QuestBoard.Tests/MainViewModelTests.cs`

```csharp
using System.Collections.Generic;
using System.Globalization;
using QuestBoard.Converters;
using QuestBoard.ViewModels;

namespace QuestBoard.Tests;

public class MainViewModelTests
{
    [Fact]
    public void Starts_with_two_quests_and_one_left()
    {
        var vm = new MainViewModel();
        Assert.Equal(2, vm.Quests.Count);
        Assert.Equal("1 quest left", vm.RemainingText);
    }

    [Fact]
    public void Add_is_disabled_until_a_title_is_typed()
    {
        var vm = new MainViewModel();
        Assert.False(vm.AddQuestCommand.CanExecute(null));

        var raised = 0;
        vm.AddQuestCommand.CanExecuteChanged += (_, _) => raised++;
        vm.NewTitle = "Slay the bug";

        Assert.True(raised > 0);
        Assert.True(vm.AddQuestCommand.CanExecute(null));
    }

    [Fact]
    public void Add_appends_a_trimmed_quest_and_clears_the_box()
    {
        var vm = new MainViewModel { NewTitle = "  Write tests  " };
        vm.AddQuestCommand.Execute(null);

        Assert.Equal("Write tests", vm.Quests[^1].Title);
        Assert.Equal("", vm.NewTitle);
        Assert.Equal("2 quests left", vm.RemainingText);
    }

    [Fact]
    public void Ticking_a_quest_updates_RemainingText_and_notifies()
    {
        var vm = new MainViewModel();
        var changed = new List<string?>();
        vm.PropertyChanged += (_, e) => changed.Add(e.PropertyName);

        vm.Quests[0].IsDone = true;

        Assert.Equal("0 quests left", vm.RemainingText);
        Assert.Contains(nameof(MainViewModel.RemainingText), changed);
    }

    [Fact]
    public void Remove_needs_a_selection()
    {
        var vm = new MainViewModel();
        Assert.False(vm.RemoveSelectedCommand.CanExecute(null));

        vm.SelectedQuest = vm.Quests[0];
        Assert.True(vm.RemoveSelectedCommand.CanExecute(null));

        vm.RemoveSelectedCommand.Execute(null);
        Assert.Single(vm.Quests);
    }

    [Fact]
    public void Converter_fades_finished_quests()
    {
        var c = new DoneToOpacityConverter();
        Assert.Equal(0.45, c.Convert(true, typeof(double), null, CultureInfo.InvariantCulture));
        Assert.Equal(1.0, c.Convert(false, typeof(double), null, CultureInfo.InvariantCulture));
    }
}
```

**7. Build, test, run**

```bash
dotnet build
dotnet test
dotnet run --project QuestBoard
```

Expected test output (timing varies):

```text
Passed!  - Failed:     0, Passed:     6, Skipped:     0, Total:     6, Duration: 14 ms - QuestBoard.Tests.dll (net10.0)
```

The window shows **"1 quest left"**, two quests (the second one faded), an empty box with a
disabled **Add** button and a disabled **Remove selected** button. Type a title → Add enables;
press Enter or click Add → the quest appears and the counter says "2 quests left". Tick a quest →
it fades and the counter drops. Select one → Remove enables.

**8. Break it on purpose** (then undo each change)

- Change `{Binding RemainingText}` to `{Binding RemainingTxt}` and run `dotnet build`: you get
  `error AVLN2000: Unable to resolve property or method of name 'RemainingTxt' on type 'QuestBoard.ViewModels.MainViewModel'` with the file and line.
- Remove `[NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]`: `dotnet test` now fails
  `Add_is_disabled_until_a_title_is_typed`, and in the app the Add button never enables.
- Delete the body of `OnQuestPropertyChanged`: ticking a quest no longer updates the counter, and
  `Ticking_a_quest_updates_RemainingText_and_notifies` fails.

:::tip
If you installed the Developer Tools app (see the warning in the binding-errors section), press
**F12** in the running (Debug) app and inspect the DataContext of a list row — it's a
`QuestItemViewModel`, exactly as the DataContext section described.
:::

- [ ] `dotnet build` succeeds with 0 errors and `dotnet test` reports 6 passed
- [ ] The app starts showing "1 quest left" and two quests, the done one faded by the converter
- [ ] Add is disabled for an empty or whitespace title and enables as you type
- [ ] Ticking a quest updates the counter; Remove selected only works with a selection
- [ ] A misspelled binding path produced an `AVLN2000` build error (then you fixed it)
:::

:::pro title="Where this goes next"
Real ViewModels receive services through their constructor (`MainViewModel(IQuestApi api)`) and are
created by dependency injection, and navigation swaps the ViewModel shown in a `ContentControl`
(the template's `ViewLocator` maps `XyzViewModel` → `XyzView`). Async commands load data with
`IsRunning` driving a spinner. The boss of this region — the BranchStory reader client against the
Capstone API — uses all of it; the patterns in this lesson are the foundation.
:::

:::info title="Same code on .NET MAUI"
The ViewModels and tests above work unchanged in a MAUI app: CommunityToolkit.Mvvm is UI-framework
neutral. In the XAML you'd set `BindingContext` instead of `DataContext`, use `Entry` instead of
`TextBox`, a `CollectionView` instead of `ListBox`, and MAUI's `IValueConverter`
(`Microsoft.Maui.Controls`). MAUI apps can't be built on Linux — use Windows or macOS for MAUI labs.
:::

:::cards id=dsk-05-cards1 xp=15 title="Binding & MVVM"
Q: What are the three parts of MVVM and who knows whom?
A: Model (data/rules) ← ViewModel (screen state + commands) ← View (XAML, binds to the ViewModel).
   The ViewModel never references controls.
Q: What is the DataContext?
A: The object a control's bindings read from by default. It's inherited by child controls
   (MAUI: BindingContext); items controls set each row's DataContext to its item.
Q: What does INotifyPropertyChanged do?
A: Exposes a PropertyChanged event; raising it with a property name tells bindings to re-read that property.
Q: What does [ObservableProperty] generate?
A: The property body that compares, stores and raises PropertyChanged, plus OnXxxChanging/OnXxxChanged hooks.
Q: [NotifyPropertyChangedFor] vs [NotifyCanExecuteChangedFor]?
A: The first also raises PropertyChanged for a dependent property; the second raises a command's
   CanExecuteChanged so buttons re-check CanExecute.
Q: What does [RelayCommand] on `Save()` create?
A: A `SaveCommand` property (IRelayCommand; IAsyncRelayCommand for async Task methods).
Q: Name the binding modes.
A: OneWay, TwoWay, OneTime, OneWayToSource, and Default (the target property's own default).
Q: Why use compiled bindings (x:DataType)?
A: Binding typos become build errors; no runtime reflection, so faster and trimming/AOT-safe.
Q: Why ObservableCollection<T> instead of List<T>?
A: It raises CollectionChanged on add/remove/reset so items controls update. It does not report
   changes to properties of the items.
Q: What is a value converter?
A: An IValueConverter used in a binding to translate source ↔ target values (Convert / ConvertBack).
Q: What is Design.DataContext for?
A: Sample data for the IDE previewer only. It has no effect at runtime.
:::

## Recap

- **MVVM** separates the View (XAML) from a testable **ViewModel** (screen state + commands) and the
  **Model**; bindings connect View and ViewModel, so code never pokes at controls.
- Bindings read from the **DataContext** (MAUI: BindingContext), which is **inherited** down the tree;
  item templates get the **item** as their DataContext.
- **INotifyPropertyChanged** is how a ViewModel says "re-read this property"; dependent properties
  must be raised too. **CommunityToolkit.Mvvm** generates it: `[ObservableProperty]`,
  `[NotifyPropertyChangedFor]`.
- **Modes**: OneWay (display), TwoWay (input), OneTime (static), OneWayToSource (rare); most targets
  have a sensible default.
- **Compiled bindings** (`x:DataType`) turn binding typos into build errors and skip reflection;
  every `DataTemplate` declares its own `x:DataType`.
- **ObservableCollection<T>** notifies adds/removes; item property changes need their own subscription.
- **Commands** (`ICommand`): buttons enable/disable from `CanExecute` and re-check only when
  `CanExecuteChanged` fires — `[RelayCommand]` + `[NotifyCanExecuteChangedFor]`.
- **Converters** adapt types in the binding; **design-time data** only feeds the previewer.
- Binding errors are mostly silent: read the log (target → path → source type), use DevTools (F12),
  and prefer compiled bindings so the compiler finds them first.
