---
id: dsk-01
title: XAML & Desktop C# Primer
level: beginner
minutes: 95
xp: 100
summary: Learn to read and write XAML by seeing how every tag, attribute and {curly} expression turns into plain C# objects, and build your first Avalonia window.
---

Welcome to the XAML Isles. Every lesson in this region uses **XAML**: Avalonia on Windows, macOS
and Linux, and .NET MAUI on phones and desktops. If you have built React components, a lot of it
will feel familiar: you describe the UI as a tree, and data flows into that tree. The syntax and
the vocabulary are different, though, and XAML error messages can be hard to read until you know
what is going on underneath.

This lesson builds that picture. When you can look at any XAML file and say *"that line creates
this object and sets these properties"*, the rest of the region gets much easier.

**What we use across the region**

| Piece | Version / command |
|---|---|
| .NET SDK | .NET 10 (`dotnet --version` → `10.0.x`) |
| Avalonia UI | 12.x (labs pin **12.1.5**) — templates via `dotnet new install Avalonia.Templates` |
| MVVM helpers | CommunityToolkit.Mvvm 8.4 (`[ObservableProperty]`, `[RelayCommand]`) |
| Bindings | compiled bindings (`x:DataType`) |
| .NET MAUI | MAUI 10 (`dotnet workload install maui`), **Windows or macOS only** |
| Running example | **QuestBoard**, a small quest/task tracker that grows lesson by lesson |
| Boss fight | a **BranchStory reader** desktop client against the Capstone API |

:::warn title="Linux and MAUI"
Avalonia apps build and run on Linux, Windows and macOS. **.NET MAUI apps cannot be built on
Linux**: Microsoft ships no MAUI workload for Linux. On Linux you can follow the Avalonia labs
fully, and the MAUI labs only as reading material (their code is exact, so you can build it later on
Windows or macOS).
:::

## Why XAML exists

A desktop UI is a **tree of objects**: a `Window` contains a `StackPanel`, which contains a
`TextBlock`, a `TextBox` and a `Button`. Each object has **properties** (`Text`, `FontSize`,
`Margin`). You could build that tree in C#:

```csharp
var panel = new StackPanel { Margin = new Thickness(16), Spacing = 12 };
panel.Children.Add(new TextBlock { Text = "Today's quests", FontSize = 22 });
panel.Children.Add(new Button { Content = "Add quest" });
var window = new Window { Title = "QuestBoard", Content = panel };
```

:::info title="C# you need to read that"
`new StackPanel { Margin = …, Spacing = 12 }` is an **object initializer**: it calls the
constructor `new StackPanel()` and then sets each listed property, exactly like writing
`var panel = new StackPanel(); panel.Spacing = 12;`. `var` lets the compiler infer the type.
`panel.Children.Add(x)` appends `x` to the panel's list of children. That is all the C# this
section needs.
:::

That works, but it has problems:

- **The shape is hidden.** You have to read every `Children.Add` to see what is nested in what.
- **Designers and tools can't help much.** A visual previewer has to run your code to show anything.
- **Layout and logic get mixed.** Colours and margins end up next to database calls.

**XAML** (eXtensible Application Markup Language, pronounced "zammel") is **XML that describes an
object tree**. Here is the same UI:

```xml
<Window Title="QuestBoard">
  <StackPanel Margin="16" Spacing="12">
    <TextBlock Text="Today's quests" FontSize="22" />
    <Button Content="Add quest" />
  </StackPanel>
</Window>
```

The nesting *is* the tree. A XAML **compiler** reads this file at build time and produces code that
does the same thing as the `new StackPanel { … }` version you would have written by hand. XAML is
not a separate runtime or a template language: **it is a shorter way to write .NET object
construction.**

:::info title="XML in 60 seconds"
XAML follows the rules of **XML**, a text format made of nested tags:

- An **element** is `<Name>…</Name>`, or `<Name />` when it has nothing inside (self-closing).
- Every opened tag must be closed, in the right order: `<A><B></B></A>`, never `<A><B></A></B>`.
- An **attribute** is `Name="value"` inside the opening tag. The value is always in quotes.
- Names are **case-sensitive**: `<Button>` and `<button>` are different.
- A comment is `<!-- like this -->`.

If you know HTML this looks familiar, but XML is stricter: a forgotten closing tag is an error,
not something the browser quietly fixes.
:::

:::info title="One idea, several frameworks"
XAML first appeared in WPF (2006). Today it is used by **WPF** and **WinUI** (Windows only),
**.NET MAUI** (Android, iOS, macOS, Windows) and **Avalonia** (Windows, macOS, Linux, plus mobile
and browser). The control names and some details differ, but the syntax rules in this lesson
apply to all of them.
:::

:::quiz id=dsk-01-q1 xp=10
What does the XAML compiler do with `<TextBlock Text="Hi" FontSize="22" />`?
- [ ] It sends the markup to the GPU, which draws it like HTML
- [x] It creates a `TextBlock` object and sets its `Text` and `FontSize` properties, just like `new TextBlock { Text = "Hi", FontSize = 22 }`
- [ ] It creates a string that the window parses again on every frame
- [ ] It creates a CSS rule named `TextBlock`
> XAML is a description of objects. Each element becomes an instance of a .NET class, and each
> attribute sets a property on that instance. Nothing is parsed again at runtime per frame; the
> result is ordinary C# objects, the same ones you could create with `new`.
:::

## The four syntax rules

XAML has very little syntax. Four rules cover almost every file you will read.

### 1. An element is an object

`<Button />` means "create a `Button`" (calls its parameterless constructor). The tag name is a
**class name**. Elements are case-sensitive: `<button />` is an error because no class is
called `button`.

### 2. An attribute is a property

`Content="Add quest"` sets the `Content` property. Attribute values are always text in the file, so
the compiler uses **type converters** to turn the text into the right type:

| You write | Property type | What gets created |
|---|---|---|
| `FontSize="22"` | `double` | `22.0` |
| `IsEnabled="False"` | `bool` | `false` |
| `Margin="16,8"` | `Thickness` | `new Thickness(16, 8)` (left/right 16, top/bottom 8) |
| `Background="#5AD1C8"` | `IBrush` | a solid-colour brush, like `new SolidColorBrush(Color.Parse("#5AD1C8"))` |
| `ColumnDefinitions="Auto,*"` | `ColumnDefinitions` | two columns: sized to content, then the rest |

An attribute can also be an **event**: `Click="OnAddClick"` subscribes the method `OnAddClick`
to the button's `Click` event (more on that below).

### 3. Child elements fill the content property

What happens to elements placed *inside* another element? Each class marks one property as its
**content property** (in C# it carries a `[Content]` attribute). For `StackPanel` it is `Children`,
for `Button` and `Window` it is `Content`, for `Border` it is `Child`, and for `TextBox` it is
`Text`. So these two lines are identical:

```xml
<Button Content="Add quest" />
<Button>Add quest</Button>
```

`TextBlock` is a small exception worth knowing: its content property is `Inlines` (a list of text
runs, so you can mix bold and normal text). `<TextBlock>Hi</TextBlock>` still *shows* "Hi", but it
fills `Inlines`, not `Text`. When you want a single string, or a binding, write
`Text="…"` as an attribute.

A `Window` or `Button` has a single `Content`, so it can hold only **one** child. To put several
things in a window, wrap them in a **panel** (`StackPanel`, `Grid`, `DockPanel`) whose `Children`
is a list.

### 4. Property-element syntax for complex values

Some values can't be written as a short string, for example a gradient brush or a whole
context menu. For those, you write the property as an element called `Owner.Property`:

```xml
<Border Padding="8">
  <Border.Background>
    <LinearGradientBrush StartPoint="0%,0%" EndPoint="100%,0%">
      <GradientStop Offset="0" Color="#5AD1C8" />
      <GradientStop Offset="1" Color="#3A7BD5" />
    </LinearGradientBrush>
  </Border.Background>
  <TextBlock Text="Quest of the day" />
</Border>
```

`<Border.Background>` is **not** a child object. It means "the thing inside me is the value of
`Background`". The `TextBlock` *is* the child (it goes into `Child`, the content property of
`Border`). In C#:

```csharp
var border = new Border
{
    Padding = new Thickness(8),
    Background = new LinearGradientBrush { /* … stops … */ },
    Child = new TextBlock { Text = "Quest of the day" },
};
```

:::tip title="Spot the dot"
The rule of thumb: if an element's tag contains a dot (`Grid.RowDefinitions`, `Button.Flyout`,
`Window.Resources`), it sets a property. If not, it creates an object.
:::

:::quiz id=dsk-01-q2 xp=10
How many objects does this XAML create?

```xml
<Border>
  <Border.Background>
    <SolidColorBrush Color="Teal" />
  </Border.Background>
  <TextBlock Text="Hi" />
</Border>
```

- [ ] 4: `Border`, `Border.Background`, `SolidColorBrush`, `TextBlock`
- [x] 3: `Border`, `SolidColorBrush`, `TextBlock`
- [ ] 2: `Border` and `TextBlock`
- [ ] 1: only `Border`; the rest are strings
> `<Border.Background>` is property-element syntax: it creates nothing by itself, it only says
> "the next object is the value of `Background`". The real objects are the `Border`, the brush
> assigned to `Background`, and the `TextBlock` that becomes the border's `Child`.
:::

:::quiz id=dsk-01-q3 xp=10
Why does this fail to compile?

```xml
<Window Title="QuestBoard">
  <TextBlock Text="Quests" />
  <Button Content="Add" />
</Window>
```

- [ ] `Title` must be set with property-element syntax
- [ ] A `Button` can't be inside a `Window`
- [x] `Window.Content` holds a single object, but two children were given; wrap them in a panel such as `StackPanel`
- [ ] The elements must be written in lowercase
> Child elements go into the content property. For `Window` that is `Content`, which holds one
> object. Panels (`StackPanel`, `Grid`, …) have a `Children` collection, so the usual fix is to put
> one panel in the window and the controls inside the panel. Avalonia reports it as
> `AVLN3000: Unable to find a setter that allows multiple assignments to the property Content`.
:::

### Attached properties: `Grid.Row="1"`

One more attribute shape: `Owner.Property="value"` on an element that is *not* the owner.

```xml
<Grid RowDefinitions="Auto,*">
  <TextBlock Grid.Row="0" Text="Header" />
  <ListBox Grid.Row="1" />
</Grid>
```

`TextBlock` has no `Row` property. `Grid.Row` is an **attached property**: the `Grid` defines it and
lets any child carry a value for it. The compiler turns it into a call to a **static** method (one
that belongs to the class `Grid` itself, not to a particular grid object): `Grid.SetRow(textBlock, 0)`.
The parent `Grid` reads the value later, when it lays out its children. `DockPanel.Dock` and
`Canvas.Left` work the same way.

:::quiz id=dsk-01-q11 xp=10
In `<Button Grid.Column="2" Content="Save" />`, which statement is true?
- [ ] `Button` has its own `Column` property, and `Grid.` is just a namespace prefix
- [x] `Grid.Column` is an attached property: the `Grid` class defines it, the button only stores a value, and the compiler emits `Grid.SetColumn(button, 2)`
- [ ] It creates a new `Grid` with three columns around the button
- [ ] It is property-element syntax, so the button's content becomes `2`
> A dotted **attribute** on an element of another type is an attached property. The value is stored
> on the button, but only the parent `Grid` uses it during layout. Property-element syntax is a
> dotted **element** (`<Grid.ColumnDefinitions>`), not an attribute.
:::

:::challenge id=dsk-01-c1 lang=ts xp=40
title: Build the object tree
The XAML compiler turns a parsed XML tree into objects. Write `buildTree(node)` that does the same
for a simplified node:

```ts
type XNode = { tag: string; attrs?: Record<string, string>; children?: XNode[]; text?: string }
```

Return `{ type: tag, children: [...], ...properties }` where:

1. Every attribute becomes a property. Convert the text like a type converter would:
   `"True"`/`"False"` → booleans, numeric text (`"22"`, `"0.5"`) → numbers, anything else stays a string.
2. `text` becomes the `Content` property (the content property shortcut).
3. A child whose tag contains a dot (`Border.Background`) is **property-element syntax**: set the
   property named after the dot (`Background`) to the built first child. It is *not* added to `children`.
4. Every other child is built recursively and pushed to `children`, in order.

hint: Start with `const obj = { type: node.tag, children: [] }`, then loop over `Object.entries(node.attrs ?? {})`.
hint: For numbers, `v.trim() !== '' && !Number.isNaN(Number(v))` works. `"16,8"` gives `NaN`, so it stays a string.
hint: For a dotted tag: `child.tag.slice(child.tag.indexOf('.') + 1)` is the property name, and `child.children?.[0]` is its value.

```ts starter
type XNode = { tag: string; attrs?: Record<string, string>; children?: XNode[]; text?: string }
type UiObject = { type: string; children: UiObject[]; [prop: string]: unknown }

export function buildTree(node: XNode): UiObject {
  // create the object, set properties, handle children
  return { type: node.tag, children: [] }
}
```

```ts solution
type XNode = { tag: string; attrs?: Record<string, string>; children?: XNode[]; text?: string }
type UiObject = { type: string; children: UiObject[]; [prop: string]: unknown }

function convert(v: string): unknown {
  if (v === 'True' || v === 'true') return true
  if (v === 'False' || v === 'false') return false
  if (v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return v
}

export function buildTree(node: XNode): UiObject {
  const obj: UiObject = { type: node.tag, children: [] }
  for (const [key, value] of Object.entries(node.attrs ?? {})) obj[key] = convert(value)
  if (node.text !== undefined) obj.Content = node.text
  for (const child of node.children ?? []) {
    const dot = child.tag.indexOf('.')
    if (dot > 0) {
      const inner = child.children?.[0]
      obj[child.tag.slice(dot + 1)] = inner ? buildTree(inner) : child.text
    } else {
      obj.children.push(buildTree(child))
    }
  }
  return obj
}
```

```ts tests
test('a leaf element copies its attributes', () => {
  expect(buildTree({ tag: 'TextBlock', attrs: { Text: 'Hi' } })).toEqual({ type: 'TextBlock', Text: 'Hi', children: [] })
})
test('converts numbers and booleans, keeps other text', () => {
  const b = buildTree({ tag: 'Button', attrs: { FontSize: '22', Opacity: '0.5', IsEnabled: 'False', Margin: '16,8' } })
  expect(b.FontSize).toBe(22)
  expect(b.Opacity).toBe(0.5)
  expect(b.IsEnabled).toBe(false)
  expect(b.Margin).toBe('16,8')
})
test('text becomes Content', () => {
  expect(buildTree({ tag: 'Button', text: 'Add quest' }).Content).toBe('Add quest')
})
test('nests children in order', () => {
  const t = buildTree({ tag: 'StackPanel', attrs: { Spacing: '12' }, children: [
    { tag: 'TextBlock', attrs: { Text: 'Quests' } },
    { tag: 'Button', text: 'Add' },
  ] })
  expect(t.Spacing).toBe(12)
  expect(t.children.map((c) => c.type)).toEqual(['TextBlock', 'Button'])
  expect(t.children[1].Content).toBe('Add')
})
test('property-element syntax sets a property instead of adding a child', () => {
  const t = buildTree({ tag: 'Border', children: [
    { tag: 'Border.Background', children: [{ tag: 'SolidColorBrush', attrs: { Color: 'Teal' } }] },
    { tag: 'TextBlock', attrs: { Text: 'Hi' } },
  ] })
  expect(t.Background).toEqual({ type: 'SolidColorBrush', Color: 'Teal', children: [] })
  expect(t.children).toHaveLength(1)
  expect(t.children[0].type).toBe('TextBlock')
})
```
:::

## Namespaces: `xmlns` and `x:`

How does the compiler know that `<Button>` means `Avalonia.Controls.Button` and not some other
`Button` class? Through **XML namespaces**. Every real XAML file starts like this:

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.ViewModels"
        x:Class="QuestBoard.MainWindow">
```

- `xmlns="…"` sets the **default namespace**. Elements without a prefix (`Window`, `Button`) are
  looked up there. The URL is only an identifier, nothing is downloaded. Avalonia maps
  `https://github.com/avaloniaui` to all its control namespaces.
- `xmlns:x="…"` maps the prefix `x:` to the **XAML language namespace**. Its members are compiler
  instructions, not controls: `x:Class`, `x:Name`, `x:Key`, `x:DataType`, `x:Null`, `x:Static`.
- `xmlns:vm="using:QuestBoard.ViewModels"` maps the prefix `vm:` to **your own C# namespace**, so
  `<vm:MainViewModel />` creates your class. (`clr-namespace:QuestBoard.ViewModels` is the older
  syntax and also works in Avalonia; MAUI code and docs use `clr-namespace:`.)

| Framework | Default `xmlns` | `x:` namespace |
|---|---|---|
| Avalonia | `https://github.com/avaloniaui` | `http://schemas.microsoft.com/winfx/2006/xaml` |
| .NET MAUI | `http://schemas.microsoft.com/dotnet/2021/maui` | `http://schemas.microsoft.com/winfx/2009/xaml` |
| WPF | `http://schemas.microsoft.com/winfx/2006/xaml/presentation` | `http://schemas.microsoft.com/winfx/2006/xaml` |

Templates also add `xmlns:d` and `xmlns:mc` with `mc:Ignorable="d"`. Attributes with the `d:` prefix
(such as `d:DesignWidth="800"`) are only for the **previewer** and are ignored when the app runs.

:::quiz id=dsk-01-q4 xp=10
In `<vm:QuestViewModel />`, what tells the compiler which C# class to create?
- [ ] Avalonia searches every loaded assembly for any class named `QuestViewModel`
- [x] The `vm` prefix is declared with `xmlns:vm="using:QuestBoard.ViewModels"`, so it means `QuestBoard.ViewModels.QuestViewModel`
- [ ] The URL in `xmlns` is downloaded and contains the class list
- [ ] `vm:` is a built-in prefix meaning "view model"
> A prefix is just a short alias declared with `xmlns:prefix="…"`. `using:` (or `clr-namespace:`)
> points it at a C# namespace. The namespace URLs for the framework itself are identifiers only:
> nothing is fetched from the network.
:::

### `x:Name` and `x:Key`

- `x:Name="QuestInput"` gives an element a **name** so C# code can reach it. The build generates a
  field `TextBox QuestInput` in your class (you will see this generated file in the lab).
- `x:Key="QuestAccent"` gives a **resource** a key so other parts of the XAML can look it up. Keys
  are used inside resource dictionaries; names are used for elements.

## Markup extensions: the `{curly}` values

Type converters handle `"22"` and `"#5AD1C8"`. Some values can't be written as a literal, though:
"*use the brush defined above*" or "*show whatever the view model's `Title` currently is*". For
those, XAML has **markup extensions**: an attribute value in curly braces is **not text**, it is a
small object that computes the value.

```xml
<TextBlock Foreground="{StaticResource QuestAccent}"
           Text="{Binding Title}" />
```

The general shape is `{Name positional, Key=Value, Key=Value}`:

```text
{Binding Title, Mode=TwoWay, FallbackValue=Untitled}
 └─name─┘ └pos┘ └──named──┘  └──────named─────────┘
```

The ones you will use daily:

| Extension | What it does | Example |
|---|---|---|
| `{StaticResource Key}` | Looks up a resource **once**, when the element is created | `Foreground="{StaticResource QuestAccent}"` |
| `{DynamicResource Key}` | Looks up a resource and **updates** when it changes (theme switching) | `Background="{DynamicResource CardBrush}"` |
| `{Binding Path}` | Connects a property to data in the `DataContext`, so the UI follows the data | `Text="{Binding Title}"` |
| `{x:Null}` | The value `null` | `Background="{x:Null}"` |
| `{x:Static Type.Member}` | A static C# field or property | `Text="{x:Static local:Strings.AppName}"` |

To write a literal `{` at the start of a value, escape it with `{}`: `Text="{}{0} quests"`.

### Resources and `{StaticResource}`

**Resources** are named objects (brushes, numbers, styles, converters) stored in a
**resource dictionary**, so you define a value once and reuse it:

```xml
<Window.Resources>
  <SolidColorBrush x:Key="QuestAccent" Color="#5AD1C8" />
  <x:Double x:Key="HeadingSize">22</x:Double>
</Window.Resources>

<TextBlock FontSize="{StaticResource HeadingSize}"
           Foreground="{StaticResource QuestAccent}" />
```

How is the key found? The lookup **walks up the tree**: first the element's own `Resources`, then
its parent's, then the parent's parent, up to the `Window`, then `Application.Resources` in
`App.axaml`, then the theme. **The nearest definition wins**, so a panel can override an app-wide
colour for its own children. If nothing matches, the lookup fails.

:::warn title="A missing key may only show up at runtime"
In Avalonia, a typo such as `{StaticResource HeadingSiz}` **builds without errors** (checked with
Avalonia 12.1.5). In the lab below the window still opens and the heading quietly falls back to
the default font size; in other situations a missing resource throws when the element is created.
Run the app after you change resources, and don't rely on the build alone. The exact behaviour
depends on the Avalonia version: see the Avalonia docs on resources
(https://docs.avaloniaui.net/docs/guides/styles-and-resources/resources).
:::

:::challenge id=dsk-01-c2 lang=ts xp=40
title: Resolve a {StaticResource}
Write `findResource(key, start, appResources)` that performs the StaticResource lookup.

Each element is a `Scope` with optional `resources` and an optional `parent`. Look in `start`,
then each parent in turn. The **nearest** match wins. If no element has it, look in
`appResources`. If that fails too, throw an `Error` whose message contains the key
(e.g. `StaticResource 'HeadingSiz' not found`).

Note that a resource value may be falsy (`0`, `''`): check whether the key **exists**, not whether
the value is truthy.

hint: `for (let s: Scope | undefined = start; s; s = s.parent) { … }` walks up the tree.
hint: `key in obj` tests for existence, even when the value is `0`.

```ts starter
type Scope = { name: string; resources?: Record<string, unknown>; parent?: Scope }

export function findResource(key: string, start: Scope, appResources: Record<string, unknown> = {}): unknown {
  return start.resources?.[key]
}
```

```ts solution
type Scope = { name: string; resources?: Record<string, unknown>; parent?: Scope }

export function findResource(key: string, start: Scope, appResources: Record<string, unknown> = {}): unknown {
  for (let s: Scope | undefined = start; s; s = s.parent) {
    if (s.resources && key in s.resources) return s.resources[key]
  }
  if (key in appResources) return appResources[key]
  throw new Error(`StaticResource '${key}' not found`)
}
```

```ts tests
const win = { name: 'Window', resources: { Accent: '#5AD1C8', HeadingSize: 22 } }
const panel = { name: 'StackPanel', parent: win, resources: { Accent: '#FF8800' } }
const text = { name: 'TextBlock', parent: panel }
const app = { Accent: '#000000', CardBrush: '#1F2933', Zero: 0 }

test('finds a resource on the element itself', () => {
  expect(findResource('Accent', panel, app)).toBe('#FF8800')
})
test('walks up to the window', () => {
  expect(findResource('HeadingSize', text, app)).toBe(22)
})
test('the nearest definition wins', () => {
  expect(findResource('Accent', text, app)).toBe('#FF8800')
})
test('falls back to application resources', () => {
  expect(findResource('CardBrush', text, app)).toBe('#1F2933')
})
test('finds falsy values', () => {
  expect(findResource('Zero', text, app)).toBe(0)
})
test('throws with the key in the message when nothing matches', () => {
  expect(() => findResource('HeadingSiz', text, app)).toThrow('HeadingSiz')
})
```
:::

:::quiz id=dsk-01-q5 xp=10
A `StackPanel` defines `<SolidColorBrush x:Key="Accent" Color="Orange"/>` in its resources, and
`App.axaml` defines `Accent` as teal. What colour does
`<TextBlock Foreground="{StaticResource Accent}"/>` inside that panel get?
- [x] Orange, because the lookup starts at the element and walks up, so the nearest definition wins
- [ ] Teal, because application resources always take priority
- [ ] A compile error, because a key may only be defined once per app
- [ ] It switches between both colours at runtime
> Resource lookup walks up from the element: its own resources, then its parents', then the window,
> the application and the theme. The first match wins, which is how a section of the UI overrides an
> app-wide value without touching anything else.
:::

:::quiz id=dsk-01-q12 xp=10
QuestBoard gets a light/dark theme switch. The card background is defined per theme under the key
`CardBrush`. Which markup makes the cards change colour **when the user switches theme while the
app is running**?
- [ ] `Background="{StaticResource CardBrush}"`
- [x] `Background="{DynamicResource CardBrush}"`
- [ ] `Background="{Binding CardBrush}"`
- [ ] `Background="CardBrush"`
> `{StaticResource}` looks the key up once, when the element is created, so it keeps the old brush.
> `{DynamicResource}` keeps watching the key and updates when the resource changes. `{Binding}` reads
> from the `DataContext` (the view model), not from resources, and plain `"CardBrush"` is just text
> the brush converter can't understand.
:::

:::challenge id=dsk-01-c3 lang=ts xp=40
title: Parse a markup extension
Write `parseMarkupExtension(value)` that reads an attribute value the way the XAML parser does.

- If the trimmed value doesn't start with `{` and end with `}`, return `null` (it's plain text).
- If it starts with the escape `{}`, return `null` too (`"{}{0} quests"` is literal text).
- Otherwise return `{ name, positional, named }`: `name` is the first word after `{`. The rest is
  split on commas. Parts without `=` are positional, and parts with `=` are named (split on the
  **first** `=`, so `Converter={StaticResource X}` keeps `{StaticResource X}` as its value). Trim
  everything.

```text
"{Binding Title, Mode=TwoWay}" → { name: 'Binding', positional: ['Title'], named: { Mode: 'TwoWay' } }
"{x:Null}"                     → { name: 'x:Null',  positional: [],        named: {} }
```

hint: `inner.search(/\s/)` finds the first whitespace; everything before it is the name.
hint: `rest.split(',').map((p) => p.trim()).filter(Boolean)` gives you the parts.

```ts starter
type MarkupExt = { name: string; positional: string[]; named: Record<string, string> }

export function parseMarkupExtension(value: string): MarkupExt | null {
  return null
}
```

```ts solution
type MarkupExt = { name: string; positional: string[]; named: Record<string, string> }

export function parseMarkupExtension(value: string): MarkupExt | null {
  const t = value.trim()
  if (!t.startsWith('{') || !t.endsWith('}') || t.startsWith('{}')) return null
  const inner = t.slice(1, -1).trim()
  const space = inner.search(/\s/)
  const name = space === -1 ? inner : inner.slice(0, space)
  const rest = space === -1 ? '' : inner.slice(space + 1)
  const positional: string[] = []
  const named: Record<string, string> = {}
  for (const part of rest.split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq === -1) positional.push(part)
    else named[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return { name, positional, named }
}
```

```ts tests
test('plain text is not an extension', () => {
  expect(parseMarkupExtension('Add quest')).toBeNull()
  expect(parseMarkupExtension('#5AD1C8')).toBeNull()
})
test('{} escapes a literal brace', () => {
  expect(parseMarkupExtension('{}{0} quests')).toBeNull()
})
test('name only', () => {
  expect(parseMarkupExtension('{x:Null}')).toEqual({ name: 'x:Null', positional: [], named: {} })
})
test('StaticResource with a key', () => {
  expect(parseMarkupExtension('{StaticResource QuestAccent}')).toEqual({ name: 'StaticResource', positional: ['QuestAccent'], named: {} })
})
test('positional and named arguments, trimmed', () => {
  expect(parseMarkupExtension(' {Binding Title,  Mode = TwoWay, FallbackValue=Untitled} ')).toEqual({
    name: 'Binding', positional: ['Title'], named: { Mode: 'TwoWay', FallbackValue: 'Untitled' },
  })
})
test('a nested extension stays as the value text', () => {
  expect(parseMarkupExtension('{Binding IsDone, Converter={StaticResource DoneToBrush}}')!.named.Converter).toBe('{StaticResource DoneToBrush}')
})
```
:::

### A first look at `{Binding}` and compiled bindings

`{StaticResource}` takes a value from the resources. `{Binding}` takes a value from **data**. Every
control has a `DataContext` (usually a **view model**, a plain C# class holding the screen's
state), and it passes its `DataContext` down to its children. `{Binding Title}` means "read
`DataContext.Title`, and update me when it changes".

```xml
<Window xmlns:vm="using:QuestBoard.ViewModels"
        x:DataType="vm:MainViewModel">
  <TextBlock Text="{Binding Title}" />
</Window>
```

`x:DataType` tells the compiler the type of the `DataContext`. With it, Avalonia uses **compiled
bindings**: the compiler checks that `MainViewModel` really has a `Title` property and produces
direct property access instead of runtime reflection. A typo becomes a **build error** instead of
a silently empty `TextBlock`. The Avalonia templates turn this on for every binding with
`<AvaloniaUseCompiledBindingsByDefault>true</AvaloniaUseCompiledBindingsByDefault>` in the
`.csproj`. Data binding and MVVM get their own lessons in this region; for now, remember that
`{Binding X}` means "property X of the DataContext".

:::quiz id=dsk-01-q6 xp=10
What is the main benefit of adding `x:DataType="vm:MainViewModel"` to a view?
- [ ] The view model is created automatically, so no `DataContext` needs to be set
- [x] Bindings are checked at build time against `MainViewModel` and compiled to direct property access, so a misspelled path is a build error
- [ ] It makes the binding two-way by default
- [ ] It is required for `{StaticResource}` to work
> `x:DataType` only declares the type: you still assign the `DataContext` yourself. Knowing the type
> lets the compiler check every `{Binding}` path and generate fast, reflection-free code. Without
> it, a typo like `{Binding Titel}` fails silently at runtime.
:::

## Code-behind and partial classes

A XAML file usually has a **code-behind** file next to it: `MainWindow.axaml` +
`MainWindow.axaml.cs`. They are two halves of **one class**:

```xml
<!-- MainWindow.axaml -->
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        x:Class="QuestBoard.Primer.MainWindow">
  <TextBox x:Name="QuestInput" />
</Window>
```

```csharp
// MainWindow.axaml.cs
namespace QuestBoard.Primer;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();   // builds the tree described in the .axaml
    }
}
```

How does this fit together?

- `x:Class="QuestBoard.Primer.MainWindow"` says "the root of this XAML **is** the class
  `QuestBoard.Primer.MainWindow`". Namespace and class name must match the C# file exactly.
- The `partial` keyword lets a C# class be split across several files. You write one part, and the
  build **generates** the other part from the XAML. It contains a field for every `x:Name` and
  the `InitializeComponent()` method.
- `InitializeComponent()` loads the compiled XAML: it creates the child objects, sets their
  properties and fills the named fields. Before this call, `QuestInput` is `null`.

The generated half looks roughly like this (you'll find the real file in the lab):

```csharp
partial class MainWindow
{
    internal TextBox QuestInput;

    public void InitializeComponent(bool loadXaml = true)
    {
        if (loadXaml) AvaloniaXamlLoader.Load(this);
        QuestInput = this.FindNameScope()?.Find<TextBox>("QuestInput");
    }
}
```

A **name scope** is the lookup table of all `x:Name`s in one XAML file. (You'll also see
`#if DEBUG … #endif` in `Program.cs`: a **compiler directive** that compiles the code between them
only into Debug builds. The template uses it to switch on the developer tools.)

:::quiz id=dsk-01-q7 xp=10
You add `<TextBlock x:Name="StatusText"/>` to `MainWindow.axaml` and use `StatusText.Text = "Hi"`
**before** calling `InitializeComponent()` in the constructor. What happens?
- [ ] It works, because XAML objects are created when the class is loaded
- [x] `NullReferenceException`, because `InitializeComponent()` is what creates the tree and assigns the `StatusText` field
- [ ] A compile error: named elements are only usable from XAML
- [ ] The text is queued and applied later
> The generated `StatusText` field starts as `null`. `InitializeComponent()` loads the XAML, builds
> the objects and then fills each named field. Always touch named elements after that call (the
> templates put it first in the constructor for this reason).
:::

:::challenge id=dsk-01-c4 lang=ts xp=35
title: Generate the named fields
Do what the name generator does. Write `namedFields(root)` that walks the tree depth-first in
document order and returns one line per element that has a `name`:
`"internal TextBox QuestInput;"` (the element's `type`, then its `name`).

Names live in one **name scope** per XAML file, so a name used twice must throw an `Error` that
mentions the duplicated name.

hint: A recursive `visit(node)` that handles the node first, then `node.children ?? []`.
hint: Keep a `Set<string>` of names seen so far.

```ts starter
type NamedNode = { type: string; name?: string; children?: NamedNode[] }

export function namedFields(root: NamedNode): string[] {
  return root.name ? [`internal ${root.type} ${root.name};`] : []
}
```

```ts solution
type NamedNode = { type: string; name?: string; children?: NamedNode[] }

export function namedFields(root: NamedNode): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  const visit = (node: NamedNode) => {
    if (node.name) {
      if (seen.has(node.name)) throw new Error(`The name '${node.name}' is already used in this scope`)
      seen.add(node.name)
      lines.push(`internal ${node.type} ${node.name};`)
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return lines
}
```

```ts tests
test('no names, no fields', () => {
  expect(namedFields({ type: 'Window', children: [{ type: 'StackPanel' }] })).toEqual([])
})
test('finds nested names in document order', () => {
  const tree = { type: 'Window', children: [
    { type: 'StackPanel', children: [
      { type: 'TextBox', name: 'QuestInput' },
      { type: 'Border', children: [{ type: 'TextBlock', name: 'StatusText' }] },
      { type: 'Button', name: 'AddButton' },
    ] },
  ] }
  expect(namedFields(tree)).toEqual([
    'internal TextBox QuestInput;',
    'internal TextBlock StatusText;',
    'internal Button AddButton;',
  ])
})
test('a duplicate name throws', () => {
  const tree = { type: 'StackPanel', children: [{ type: 'TextBox', name: 'Title' }, { type: 'TextBlock', name: 'Title' }] }
  expect(() => namedFields(tree)).toThrow('Title')
})
```
:::

## Events vs commands

There are two ways to react when the user clicks a button.

An **event** is a notification an object raises when something happens (`Click`, `TextChanged`).
Code **subscribes** to it with a method, the **event handler**, which then runs every time the event
fires. A **command** is an object that represents an *action* ("add a quest") and also knows whether
that action is currently allowed.

**An event handler in code-behind.** The XAML names a method, and the method lives in the
`.axaml.cs` file:

```xml
<Button Content="Add quest" Click="OnAddClick" />
```

```csharp
private void OnAddClick(object? sender, RoutedEventArgs e)
{
    StatusText.Text = "Quest added";
}
```

Simple and direct, but the logic is tied to the window. To test it you have to create a window,
and the handler can't easily be reused by a menu item or a keyboard shortcut.

**A command on a view model.** The button binds to an object that implements `ICommand`, which has
`Execute()` plus `CanExecute()` ("is this allowed right now?"). The button **disables itself**
whenever `CanExecute` returns `false`:

```xml
<Button Content="Add quest" Command="{Binding AddQuestCommand}" />
```

```csharp
public partial class MainViewModel : ObservableObject
{
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]
    private string _newTitle = "";

    [RelayCommand(CanExecute = nameof(CanAddQuest))]
    private void AddQuest() { /* add NewTitle to the list */ }

    private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewTitle);
}
```

The `[Square brackets]` are **C# attributes**: labels attached to code (not to be confused with XML
attributes like `Text="…"`). A **source generator** is a compiler plug-in that reads those labels
during the build and writes extra C# for you, which is why the class must be `partial`.
CommunityToolkit.Mvvm's generators write the boring parts: `[ObservableProperty]` on the field
`_newTitle` generates a public `NewTitle` property that raises change notifications, and
`[RelayCommand]` on the method `AddQuest` generates an `ICommand` property called `AddQuestCommand`. The view model has no reference to any control, so a plain unit test
can create it, set `NewTitle` and call `AddQuestCommand.Execute(null)`.

| | Event + code-behind | Command + view model |
|---|---|---|
| Where the logic lives | the window class | a plain C# class |
| Unit-testable without UI | hardly | yes |
| Enable/disable automatically | you write it | `CanExecute` does it |
| Good for | purely visual things (focus, scroll, animations) | app behaviour (save, add, delete, navigate) |

:::quiz id=dsk-01-q8 xp=10
The **Add quest** button should be greyed out while the title box is empty. What is the idiomatic
MVVM approach?
- [ ] Handle `TextChanged` in code-behind and set `AddButton.IsEnabled` by hand
- [x] Bind `Command` to a view-model command whose `CanExecute` checks the title, and re-evaluate it when the title changes
- [ ] Put an `if` inside the `Click` handler and show an error
- [ ] Use a `{StaticResource}` that holds `true` or `false`
> A command's `CanExecute` is wired to the button's enabled state. When the title changes, the
> command raises `CanExecuteChanged` (CommunityToolkit's `[NotifyCanExecuteChangedFor]` does that
> for you) and the button updates. The rule lives in testable view-model code, not in the window.
:::

:::job title="What you'll see in a real codebase"
Most professional XAML apps follow **MVVM** (Model-View-ViewModel): XAML views with almost empty
code-behind, view models with `[ObservableProperty]` and `[RelayCommand]`, and services injected
into the view models. Reviewers will often push back on business logic in `*.axaml.cs`. Code-behind
is still fine for purely visual work such as focusing a text box, scrolling to an item or starting an
animation.
:::

## `.axaml` vs `.xaml`

Avalonia files use the extension **`.axaml`** ("Avalonia XAML"); WPF, WinUI and MAUI use **`.xaml`**.
The syntax is the same XML, and the reason for the different extension is tooling: Visual Studio
would otherwise open Avalonia files with the WPF designer and report hundreds of false errors.

What really differs between frameworks is the **vocabulary**:

| Concept | Avalonia (`.axaml`) | .NET MAUI (`.xaml`) |
|---|---|---|
| Root of a screen | `Window` / `UserControl` | `ContentPage` |
| Vertical list of controls | `StackPanel Spacing="8"` | `VerticalStackLayout Spacing="8"` |
| Text display / input | `TextBlock` / `TextBox` | `Label` / `Entry` |
| Placeholder text | `PlaceholderText="…"` (`Watermark` in Avalonia 11) | `Placeholder="…"` |
| Your namespace | `xmlns:vm="using:…"` | `xmlns:vm="clr-namespace:…"` |
| Styling | CSS-like selectors: `Style Selector="Button.primary"` | WPF-like `Style TargetType="Button"` |

So moving from one to the other means learning new control names, not a new language.

:::quiz id=dsk-01-q9 xp=10
Why does Avalonia use `.axaml` instead of `.xaml`?
- [ ] `.axaml` is a binary format that loads faster
- [ ] `.axaml` files don't need namespaces
- [x] Mostly for tooling: IDEs then don't treat Avalonia files as WPF XAML; the syntax is the same XML
- [ ] Only `.axaml` supports markup extensions
> Both are plain-text XAML with the same rules (elements, attributes, property elements, markup
> extensions). The separate extension stops Visual Studio's WPF tooling from claiming the files and
> lets Avalonia's extensions provide completion and previews.
:::

## Reading XAML errors

XAML errors look scary because they mention compiler internals. The format is always the same:

```text
MainWindow.axaml(24,52,24,52): Avalonia error AVLN3000: Unable to find suitable setter …
└── file ──────┘ └line,col┘           └─ code ─┘  └── message ──┘
```

The four numbers are start line, start column, end line, end column (often the same point). Read
**file and line first**, then the code. The common ones in Avalonia:

| Code | Typical message | Usual cause |
|---|---|---|
| `AVLN1001` | `File doesn't contain valid XAML … start tag … does not match the end tag` | Broken XML: a tag not closed, a typo in a closing tag, a missing quote |
| `AVLN2000` | `Unable to resolve suitable regular or attached property Spacng on type StackPanel` | A property name typo, or a property the control doesn't have (WPF/MAUI names in Avalonia) |
| `AVLN2000` | `Unable to resolve type …` | A control name typo, or a missing `xmlns:` prefix / `using:` namespace |
| `AVLN3000` | `Unable to find suitable setter or adder for property Click …` | The event handler named in XAML doesn't exist in code-behind, or has the wrong signature |
| `AVLN3000` | `Unable to find a setter that allows multiple assignments to the property Content` | Two children in a `Window`/`Button`/`Border`; wrap them in a panel |
| C# `CS0103` | `The name 'StatusText' does not exist in the current context` | `x:Name` missing or misspelled, `x:Class` doesn't match the C# class, **or** the element's tag itself is wrong (see below) |

Two quirks that confuse beginners:

- **AVLN1001 has no line number in front.** It prints `MainWindow.axaml : Avalonia error AVLN1001`
  followed by many `at System.Xml…` stack-trace lines. Ignore those; the position is inside the
  first message (`… start tag on line 11 position 4 does not match the end tag …`).
- **C# errors can hide XAML errors.** If you misspell a tag that has an `x:Name`
  (`<textBox x:Name="QuestInput">`), the name generator can't create the field, so the build first
  shows C# `CS0103: The name 'QuestInput' does not exist`. The real cause,
  `AVLN2000: Unable to resolve type textBox`, only appears once the C# compiles. When a named field
  "disappears", look at its XAML tag.

:::tip title="Fix the first error"
One XML mistake can produce a cascade of errors. Fix the **first** XAML error in the list,
rebuild, and repeat. The rest often disappear.
:::

:::pro title="How seniors debug XAML"
They keep the previewer open but trust the **build**. They read the line/column and the
"on type X" part of the message, which tells you which object the compiler was working on. When the
app runs but looks wrong, they open **Developer Tools** (press **F12** in a Debug build of an
Avalonia app) to inspect the live visual tree, see each control's actual property values and find
out where a value came from (local, style or binding). That answers "why is this blue?" in seconds.
Setting them up (a one-time `dotnet tool install`) is covered in **Your First Avalonia App**.
:::

:::quiz id=dsk-01-q10 xp=10
The build reports
`MainWindow.axaml(11,4,11,4): Avalonia error AVLN2000: Unable to resolve suitable regular or attached property Spacng on type Avalonia.Controls:Avalonia.Controls.StackPanel`.
What do you fix?
- [ ] Install a missing NuGet package for `StackPanel`
- [ ] Add `xmlns:x` to the root element
- [x] The attribute on the `StackPanel` at line 11: `Spacng` is a typo for `Spacing`
- [ ] Rename `MainWindow.axaml` to `.xaml`
> AVLN2000 means "I know the type, but it has no property with that name". The message names both
> (`Spacng` on `StackPanel`) and the position (line 11, column 4). Usually it's a typo, or a property
> name from another framework.
:::

:::lab id=dsk-01-lab1 xp=80
title: Your first Avalonia window (QuestBoard Primer)
You will create an Avalonia app, write a window with resources, property-element syntax, named
elements and a click handler, look at the code the build generates, and then break it on purpose
to learn the error messages. Works on Windows, macOS and Linux.

**1. Check the SDK and install the templates**

```bash
dotnet --version
dotnet new install Avalonia.Templates
```

Expected: a version starting with `10.0.` and a list of templates including
`Avalonia .NET App (avalonia.app)` and `Avalonia .NET MVVM App (avalonia.mvvm)`.

:::info
This region uses Avalonia **12.x**; the project file below pins **12.1.5**, the version every
QuestBoard lab was checked with. If the templates generate a newer 12.x patch, that's fine.
:::

**2. Create the project**

```bash
mkdir -p ~/devquest-labs && cd ~/devquest-labs
dotnet new avalonia.app -o QuestBoard.Primer
cd QuestBoard.Primer
```

You get `App.axaml` (+ `.cs`), `MainWindow.axaml` (+ `.cs`), `Program.cs`, `app.manifest` and the
project file.

**3. Replace `QuestBoard.Primer.csproj`** (this pins Avalonia 12.1.5 and turns on compiled bindings):

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
    <PackageReference Include="Avalonia" Version="12.1.5" />
    <PackageReference Include="Avalonia.Desktop" Version="12.1.5" />
    <PackageReference Include="Avalonia.Themes.Fluent" Version="12.1.5" />
    <PackageReference Include="Avalonia.Fonts.Inter" Version="12.1.5" />
    <!-- Developer Tools bridge (F12), only in Debug builds -->
    <PackageReference Include="AvaloniaUI.DiagnosticsSupport" Version="2.2.3">
      <IncludeAssets Condition="'$(Configuration)' != 'Debug'">None</IncludeAssets>
      <PrivateAssets Condition="'$(Configuration)' != 'Debug'">All</PrivateAssets>
    </PackageReference>
  </ItemGroup>
</Project>
```

**4. Replace `MainWindow.axaml`**

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        x:Class="QuestBoard.Primer.MainWindow"
        Title="QuestBoard Primer" Width="420" Height="300">

  <Window.Resources>
    <SolidColorBrush x:Key="QuestAccent" Color="#5AD1C8" />
    <x:Double x:Key="HeadingSize">22</x:Double>
  </Window.Resources>

  <StackPanel Margin="16" Spacing="12">
    <TextBlock Text="Today's quests"
               FontSize="{StaticResource HeadingSize}"
               Foreground="{StaticResource QuestAccent}" />

    <Border Padding="8" CornerRadius="6">
      <Border.Background>
        <SolidColorBrush Color="#1F2933" />
      </Border.Background>
      <TextBlock Text="Add a quest, then press the button." Foreground="White" />
    </Border>

    <TextBox x:Name="QuestInput" PlaceholderText="New quest title" />
    <Button x:Name="AddButton" Content="Add quest" Click="OnAddClick" />
    <TextBlock x:Name="StatusText" Text="0 quests added" />
  </StackPanel>
</Window>
```

**5. Replace `MainWindow.axaml.cs`**

```csharp
using Avalonia.Controls;
using Avalonia.Interactivity;

namespace QuestBoard.Primer;

public partial class MainWindow : Window
{
    private int _count;

    public MainWindow()
    {
        InitializeComponent();
        // The same kind of object tree, built from C#:
        if (Content is StackPanel root)
            root.Children.Add(new TextBlock { Text = "Added from C#", Opacity = 0.7 });
    }

    private void OnAddClick(object? sender, RoutedEventArgs e)
    {
        var title = QuestInput.Text?.Trim();
        if (string.IsNullOrEmpty(title))
        {
            StatusText.Text = "Type a title first";
            return;
        }

        _count++;
        StatusText.Text = $"{_count} quest(s) added - last: {title}";
        QuestInput.Text = "";
    }
}
```

**6. Build and run**

```bash
dotnet build
dotnet run
```

Expected build output ends with:

```text
Build succeeded.
    0 Warning(s)
    0 Error(s)
```

A window opens with a teal heading, a dark info box, a text box, a button, the status line and a
grey "Added from C#" line. Click **Add quest** with an empty box (you should see
`Type a title first`), then type `Slay the bug` and click again (you should see
`1 quest(s) added - last: Slay the bug`). (Optional: if you've already installed Avalonia's
Developer Tools, as shown in **Your First Avalonia App**, press **F12** and expand the visual tree
to find your `StackPanel`, `Border` and `TextBox`.)

**7. Look at the generated half of the partial class**

```bash
dotnet build --no-incremental -p:EmitCompilerGeneratedFiles=true
find obj -name 'QuestBoard.Primer.MainWindow.g.cs'
```

Open the file it prints. You will find `internal global::Avalonia.Controls.TextBox QuestInput;`,
the same for `AddButton` and `StatusText`, and the `InitializeComponent` method that calls
`AvaloniaXamlLoader.Load(this)` and then fills the fields with `Find<…>("QuestInput")`.

**8. Break it on purpose** (undo each change before the next):

| Change in `MainWindow.axaml` | Expected `dotnet build` error |
|---|---|
| `Click="OnAddClick"` → `Click="OnAddClik"` | `error AVLN3000: Unable to find suitable setter or adder for property Click of type …Button` |
| `Spacing="12"` → `Spacng="12"` | `error AVLN2000: Unable to resolve suitable regular or attached property Spacng on type …StackPanel` |
| `</StackPanel>` → `</StackPanl>` | `error AVLN1001: File doesn't contain valid XAML: … does not match the end tag of 'StackPanl'` |
| `<StackPanel Margin="16"…>` → put `<TextBlock Text="extra" />` right before it | `error AVLN3000: Unable to find a setter that allows multiple assignments to the property Content …` |
| `HeadingSize}` → `HeadingSiz}` | **builds successfully**; run it: the window opens, but the heading has the default size |

:::tip
Write the four error codes into your notes file with one line about each. You will see all of
them again.
:::

- [ ] `dotnet build` reports `0 Error(s)` and `dotnet run` opens the QuestBoard Primer window
- [ ] Clicking **Add quest** shows `Type a title first`, then counts quests after you type a title
- [ ] I found `QuestBoard.Primer.MainWindow.g.cs` and saw the generated `QuestInput` field
- [ ] I triggered AVLN1001, AVLN2000 and AVLN3000 and can say what each means
- [ ] I saw that a misspelled `{StaticResource}` key is not caught by the build
:::

:::cards id=dsk-01-cards1 xp=15 title="XAML basics"
Q: What is XAML, in one sentence?
A: XML that describes a tree of .NET objects: elements create objects, attributes set their properties.
Q: How does `FontSize="22"` (text) become a `double`?
A: A type converter turns the attribute text into the property's type (also `"16,8"` → `Thickness`, `"#5AD1C8"` → brush).
Q: What is property-element syntax?
A: `<Owner.Property>…</Owner.Property>`: the child object becomes the value of that property instead of a child, e.g. `<Border.Background>`.
Q: What is a content property?
A: The property that child elements fill: `Content` for Button/Window, `Children` for panels, `Child` for Border (`Inlines` for TextBlock).
Q: What is an attached property?
A: A property defined by one class but set on another, like `Grid.Row="1"`, compiled to `Grid.SetRow(element, 1)`.
Q: `xmlns` vs `xmlns:x`?
A: The default namespace maps unprefixed elements to the framework's controls; `x:` is the XAML language itself (`x:Class`, `x:Name`, `x:Key`, `x:DataType`).
Q: `x:Name` vs `x:Key`?
A: `x:Name` names an element and generates a field in code-behind; `x:Key` names a resource in a resource dictionary.
Q: What is a markup extension?
A: A `{…}` attribute value that computes the value: `{StaticResource}`, `{DynamicResource}`, `{Binding}`, `{x:Null}`, `{x:Static}`.
Q: How is `{StaticResource Key}` resolved?
A: It walks up from the element: its own resources, then its parents', the window, `Application.Resources`, then the theme. The nearest match wins.
Q: StaticResource vs DynamicResource?
A: Static looks the value up once, when the element is created. Dynamic keeps watching and updates when the resource changes (e.g. theme switch).
Q: What does `x:DataType` give you?
A: Compiled bindings: binding paths are checked at build time and compiled to direct property access.
Q: What does `InitializeComponent()` do?
A: It loads the compiled XAML, builds the object tree and fills the generated fields for every `x:Name`.
Q: Why `partial class`?
A: The class is split across your code-behind file and a build-generated file (named fields + `InitializeComponent`).
Q: Event handler vs command?
A: An event runs a code-behind method tied to the view. A command (`ICommand` with `Execute`/`CanExecute`) lives on a view model, is unit-testable and enables/disables the button.
Q: AVLN2000 / AVLN3000 / AVLN1001?
A: 2000: unknown property or type. 3000: a value/handler can't be assigned (e.g. missing event handler). 1001: invalid XML.
:::

## Recap

- XAML is **XML that builds an object tree**: element = object, attribute = property, and the
  compiler turns it into the same C# you could write with `new`.
- Text attributes go through **type converters**. Child elements fill the **content property**.
  `<Owner.Property>` is **property-element syntax**, and `Grid.Row="1"` is an **attached property**.
- `xmlns` maps prefixes to namespaces: the default one for controls, `x:` for language features,
  and `using:` (Avalonia) or `clr-namespace:` (MAUI) for your own classes.
- **Markup extensions** in `{}` compute values: `{StaticResource}` walks up the tree (nearest wins),
  `{Binding}` reads from the `DataContext`, and `x:DataType` makes bindings compiled and checked.
- **Code-behind** is the other half of a `partial class`. `x:Class` links them, and
  `InitializeComponent()` builds the tree and fills `x:Name` fields.
- **Events** suit purely visual code-behind work; **commands** on view models (CommunityToolkit's
  `[RelayCommand]`) are testable and drive `CanExecute`.
- `.axaml` (Avalonia) and `.xaml` (MAUI/WPF) share the syntax but differ in control vocabulary.
  MAUI can't be built on Linux.
- Read XAML errors by file, line and code: AVLN1001 means broken XML, AVLN2000 an unknown
  property or type, AVLN3000 a value or handler that can't be assigned. Fix the first error first.
