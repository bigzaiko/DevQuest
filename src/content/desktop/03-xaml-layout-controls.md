---
id: dsk-04
title: Layout & Controls in XAML
level: intermediate
minutes: 90
xp: 150
summary: How XAML measures and arranges a window, which panel to pick (Grid, DockPanel, StackPanel, WrapPanel, UniformGrid, Canvas), the everyday controls, responsive layouts and keyboard and screen-reader access, all built into QuestBoard.
---

You can have the best view models in the world, but users judge an app by its window. Does it fill a
big monitor without awkward gaps? Can you shrink it next to your editor without buttons disappearing
off the edge? Can you use it with only a keyboard? All of that is **layout**: the part of the UI
framework that decides where every control goes and how big it is.

In this lesson you learn how that decision is made (the *layout pass*), the panels that make it,
the controls you'll put on screen every day, and how to make it all responsive and accessible. Then
you lay out the real **QuestBoard** window in Avalonia and check it with headless UI tests.

:::info title="Which framework is this?"
The XAML here is **Avalonia** (Avalonia 11 and newer; right now `dotnet new avalonia.mvvm` creates a
12.x project). WPF, WinUI and .NET MAUI use the same ideas, often with the same names. Where MAUI is
different, a short note says so.
:::

## How layout works: measure, then arrange

**Why it matters:** "my ListBox doesn't scroll" and "my text is cut off" are the most common XAML
questions. Nearly every one of them makes sense once you know the two-step layout algorithm.

A window is a **tree** of controls. Panels (a **panel** is a control whose job is to position its
children) contain other controls, and those can contain more. Every time the tree changes (a window
resizes, text changes, an item is added), the framework runs a **layout pass** over it, in two
phases.

1. **Measure** (from the top down, answers coming back up). Each parent asks each child: *"I can
   give you up to this much space. How much do you want?"* The space offered is the **available
   size**. It may be infinite, which means "as much as you like". The child measures its own
   children and answers with its **desired size**.
2. **Arrange** (top down again). Now that the parent knows what everyone wants, it decides the
   final rectangle for each child (its **slot**) and tells the child: *"you get this box, at this
   position."* The child places its own children inside that box.

A tiny example. A vertical `StackPanel` in a 300 × 200 window holding two buttons:

```xml
<StackPanel>
  <Button Content="Save" />
  <Button Content="Cancel" />
</StackPanel>
```

```text
Measure:  Window offers 300 x 200 to StackPanel
          StackPanel offers 300 x ∞ to each Button   ← a vertical stack never limits height
          Save wants 52 x 32, Cancel wants 64 x 32   ← example numbers
          StackPanel wants 64 x 64
Arrange:  StackPanel gets 300 x 200
          Save gets the slot (0, 0, 300, 32), Cancel gets (0, 32, 300, 32)
```

Notice the buttons are 300 wide, not 52: their slot is the full width, and a button **stretches**
by default. That's alignment, which comes later.

:::tip title="The infinite-space rule"
A vertical `StackPanel` (and a `ScrollViewer`) measures its children with **infinite height**. A
child that is offered infinite height can never be "too tall", so it never shows its own scrollbar.
Keep this in mind, because it explains the most common layout bug below.
:::

Terms you will meet in the docs and in exceptions:

| Term | Meaning |
| --- | --- |
| `DesiredSize` | What a control asked for during measure (includes its `Margin`). |
| `Bounds` | The final rectangle after arrange, relative to the parent. |
| `InvalidateMeasure()` / `InvalidateArrange()` | "Something changed, redo layout for me." Controls call these themselves when a property like `Text` or `Width` changes. |
| `UpdateLayout()` | Run the pending layout pass *now* (handy in tests). |

:::quiz id=dsk-04-q1 xp=10
During the **measure** phase, what does a child control report back to its parent?
- [ ] Its final position on screen
- [x] Its desired size: how much space it would like, given the space offered
- [ ] The size of the window
- [ ] Nothing; measuring is done only by the parent
> Measure is a question and an answer: the parent offers an *available size* and the child answers
> with its `DesiredSize`. The final position and size (the slot) is only decided in the second
> phase, **arrange**. The window size is just the starting point at the top of the tree.
:::

## Size, alignment, margin and padding

Before panels, four properties that every control has. They decide what a control does *inside* the
slot its panel gives it.

- `Width` / `Height`: a fixed size. Use them rarely, because fixed sizes break with long translations
  and large fonts. Prefer `MinWidth` / `MaxWidth` / `MinHeight` / `MaxHeight`, which set limits but
  still let the control grow and shrink.
- `HorizontalAlignment`: `Stretch` (the default for most controls: fill the slot), `Left`, `Center`,
  `Right`. `VerticalAlignment` works the same way with `Top`, `Center`, `Bottom`, `Stretch`.
  With anything other than `Stretch`, the control uses its desired size and is positioned inside the
  slot.
- `Margin`: space **outside** the control's border, between it and its neighbours.
- `Padding`: space **inside** the border, between the border and the content. Only controls with
  content have it (`Button`, `Border`, `TextBox`, …), not panels like `StackPanel`.

The values of `Margin` and `Padding` are a **thickness**. You can write it in three forms:

```xml
<Border Margin="8" />            <!-- 8 on all four sides -->
<Border Margin="16,4" />         <!-- 16 left and right, 4 top and bottom -->
<Border Margin="16,0,8,4" />     <!-- left, top, right, bottom (clockwise from the left) -->
```

A small example with all four:

```xml
<Border Background="LightBlue" Width="300" Height="80">
  <Button Content="Join quest"
          HorizontalAlignment="Right" VerticalAlignment="Center"
          Margin="0,0,12,0" Padding="20,6" />
</Border>
```

The button sits at the right of the 300 px box, 12 px away from the edge (margin). Its text has 20 px
of space on the left and right inside the button (padding). It is only as wide as its content plus
padding, because `Right` means "don't stretch".

:::warn title="Explicit Width beats Stretch"
`HorizontalAlignment="Stretch"` only stretches a control that has no `Width`. If you set
`Width="120"`, the control is 120 wide and is centred in a wider slot. If a control "refuses to
fill", look for a forgotten `Width`, or a style that sets one.
:::

:::quiz id=dsk-04-q2 xp=10
You want **more space between a button's text and its border**, without moving the button away from
its neighbours. Which property do you change?
- [ ] `Margin`
- [x] `Padding`
- [ ] `HorizontalAlignment`
- [ ] `Width`
> `Padding` is space *inside* the border, around the content. `Margin` is space *outside* it, which
> would push the neighbours away. Setting `Width` makes the button bigger, but it doesn't keep the
> text centred with even spacing, and it breaks when the text is translated.
:::

:::challenge id=dsk-04-c1 lang=ts xp=30
title: Arrange a child in its slot
Simulate the **arrange** step for one axis. A panel has given a child a slot `slot` pixels wide. The
child measured its content as `desired` pixels (margin not included). Return the child's final `x`
(offset inside the slot) and `width`.

- `margin` is `[left, right]` (default `[0, 0]`). The usable space is `slot - left - right`, never
  negative.
- `Stretch`: the child fills the usable space.
- `Left` / `Center` / `Right`: the width is `desired`, but never more than the usable space, and the
  child is placed at the left, centre or right of the usable space.
- `x` always includes the left margin.

Example: `arrange(300, 80, 'Center')` → `{ x: 110, width: 80 }`.

hint: Start with `const inner = Math.max(0, slot - left - right)`.
hint: `width = align === 'Stretch' ? inner : Math.min(desired, inner)`; the free space is `inner - width`.
hint: Left adds 0 of the free space to `x`, Center adds half, Right adds all of it.

```ts starter
type Align = 'Stretch' | 'Left' | 'Center' | 'Right'

export function arrange(slot: number, desired: number, align: Align, margin: [number, number] = [0, 0]): { x: number; width: number } {
  // your code
  return { x: 0, width: desired }
}
```

```ts solution
type Align = 'Stretch' | 'Left' | 'Center' | 'Right'

export function arrange(slot: number, desired: number, align: Align, margin: [number, number] = [0, 0]): { x: number; width: number } {
  const [left, right] = margin
  const inner = Math.max(0, slot - left - right)
  const width = align === 'Stretch' ? inner : Math.min(desired, inner)
  const free = inner - width
  const offset = align === 'Center' ? free / 2 : align === 'Right' ? free : 0
  return { x: left + offset, width }
}
```

```ts tests
test('Stretch fills the slot', () => {
  expect(arrange(300, 80, 'Stretch')).toEqual({ x: 0, width: 300 })
})
test('Left, Center and Right keep the desired width', () => {
  expect(arrange(300, 80, 'Left')).toEqual({ x: 0, width: 80 })
  expect(arrange(300, 80, 'Center')).toEqual({ x: 110, width: 80 })
  expect(arrange(300, 80, 'Right')).toEqual({ x: 220, width: 80 })
})
test('margins shrink the usable space and shift x', () => {
  expect(arrange(300, 80, 'Stretch', [10, 20])).toEqual({ x: 10, width: 270 })
  expect(arrange(300, 80, 'Right', [10, 20])).toEqual({ x: 200, width: 80 })
})
test('a child never gets more than the slot', () => {
  expect(arrange(100, 150, 'Center')).toEqual({ x: 0, width: 100 })
  expect(arrange(20, 50, 'Left', [15, 15])).toEqual({ x: 15, width: 0 })
})
```
:::

## Panels: choosing the right container

**Why there are several:** each panel has one layout rule. Choosing a panel is choosing a rule. Real
screens nest a few simple panels rather than forcing one panel to do everything.

### StackPanel: one after another

Puts children in a line, vertically (default) or with `Orientation="Horizontal"`. `Spacing` adds a
gap between children.

```xml
<StackPanel Spacing="8">
  <TextBlock Text="Quest title" />
  <TextBox />
  <Button Content="Save" HorizontalAlignment="Right" />
</StackPanel>
```

Use it for short forms, button rows and the content of a list item. Don't use it for anything that
must fill the window or scroll. Remember the infinite-space rule.

### Grid: rows and columns

The workhorse. You define rows and columns, then put each child in a cell with the **attached
properties** `Grid.Row` and `Grid.Column`. (An *attached property* is a property defined by one
class, here `Grid`, that you set on another control. It's how a child tells its parent panel where it
wants to go.) `Grid.RowSpan` / `Grid.ColumnSpan` let a child cover several cells.

Each row or column has a size of one of three kinds:

| Size | Written as | Meaning |
| --- | --- | --- |
| Pixel | `120` | Exactly 120 device-independent pixels (1/96 inch; at 200 % display scaling that is 240 physical pixels). |
| Auto | `Auto` | As big as the largest child in that row or column. |
| Star | `*`, `2*`, `0.5*` | A share of whatever space is **left over** after pixel and Auto sizes. `2*` gets twice as much as `*`. |

Avalonia and MAUI let you write the definitions as a short comma-separated string. Classic WPF
code uses the longer element syntax, which Avalonia also understands. Both mean the same thing:

```xml
<!-- Avalonia shorthand -->
<Grid ColumnDefinitions="Auto,*,120" RowDefinitions="Auto,*">

<!-- Long form (WPF, and also valid in Avalonia) -->
<Grid>
  <Grid.ColumnDefinitions>
    <ColumnDefinition Width="Auto" />
    <ColumnDefinition Width="*" />
    <ColumnDefinition Width="120" />
  </Grid.ColumnDefinitions>
</Grid>
```

How the space is shared, step by step, for `ColumnDefinitions="Auto,*,2*"` in a 700 px wide grid
whose Auto column holds a 100 px label:

```text
1. Pixel columns:  none
2. Auto columns:   column 0 = 100            (its widest child)
3. Left over:      700 - 100 = 600
4. Star columns:   * + 2* = 3 shares → 1 share = 200
                   column 1 = 200, column 2 = 400
```

If the window is too small for the pixel and Auto columns, the star columns get **0**, not a
negative width. The content is then clipped.

A typical form row: label, input that takes the rest, button.

```xml
<Grid ColumnDefinitions="Auto,*,Auto">
  <TextBlock Grid.Column="0" Text="Title" VerticalAlignment="Center" Margin="0,0,8,0" />
  <TextBox   Grid.Column="1" />
  <Button    Grid.Column="2" Content="Add" Margin="8,0,0,0" />
</Grid>
```

:::quiz id=dsk-04-q3 xp=10
A Grid is 700 px wide with `ColumnDefinitions="Auto,*,2*"`. The only child in column 0 is 100 px
wide. How wide are the three columns?
- [ ] 100, 300, 300
- [x] 100, 200, 400
- [ ] 233, 233, 233
- [ ] 100, 600, 1200
> The Auto column takes what its content needs (100). The leftover 600 is split into 1 + 2 = 3
> shares of 200: `*` gets one share (200), `2*` gets two (400). Star sizes are shares of what's
> **left**, not of the whole width.
:::

:::challenge id=dsk-04-c2 lang=ts xp=50
title: Grid column width calculator
Write `gridColumns(defs, available, content)` that returns the final width of every column, the way
a Grid computes it.

- `defs[i]` is `'Auto'`, a pixel value like `'120'`, or a star value: `'*'`, `'2*'`, `'0.5*'`
  (`'*'` alone means `1*`).
- `available` is the grid's width.
- `content[i]` is the width of the widest child in column `i`. Only Auto columns use it.
- Pixel and Auto columns are sized first. The leftover (never negative) is shared between star
  columns in proportion to their weights.
- If there is no star column, return the pixel and Auto widths as they are (any extra space stays
  unused).

This is a simplified model: a real Grid also honours `MinWidth`/`MaxWidth` on the column
definitions and the content of star columns, but the core arithmetic is exactly this.

Example: `gridColumns(['Auto', '*', 'Auto'], 900, [40, 0, 80])` → `[40, 780, 80]`.

hint: Do two passes: first sum the pixel and Auto widths and the star weights, then hand out the leftover.
hint: `parseFloat('2*')` is `2`, and `parseFloat('*')` is `NaN`, so treat a bare `'*'` as weight 1.
hint: `const leftover = Math.max(0, available - fixed)`, then each star column gets `leftover * weight / totalWeight`.

```ts starter
export function gridColumns(defs: string[], available: number, content: number[]): number[] {
  // your code
  return defs.map(() => 0)
}
```

```ts solution
export function gridColumns(defs: string[], available: number, content: number[]): number[] {
  const isStar = (d: string) => d.trim().endsWith('*')
  const weight = (d: string) => {
    const n = parseFloat(d)
    return Number.isNaN(n) ? 1 : n
  }
  let fixed = 0
  let totalWeight = 0
  const widths = defs.map((d, i) => {
    if (isStar(d)) {
      totalWeight += weight(d)
      return 0
    }
    const w = d.trim().toLowerCase() === 'auto' ? content[i] ?? 0 : parseFloat(d)
    fixed += w
    return w
  })
  const leftover = Math.max(0, available - fixed)
  return defs.map((d, i) => (isStar(d) && totalWeight > 0 ? (leftover * weight(d)) / totalWeight : widths[i]))
}
```

```ts tests
test('Auto columns hug their content, * takes the rest', () => {
  expect(gridColumns(['Auto', '*', 'Auto'], 900, [40, 0, 80])).toEqual([40, 780, 80])
})
test('star weights share the leftover', () => {
  expect(gridColumns(['*', '2*'], 300, [0, 0])).toEqual([100, 200])
  expect(gridColumns(['1.5*', '*'], 500, [0, 0])).toEqual([300, 200])
})
test('pixel columns are exact and star ignores content', () => {
  expect(gridColumns(['100', 'Auto', '*'], 400, [0, 50, 999])).toEqual([100, 50, 250])
})
test('star columns get 0 when there is no space left', () => {
  expect(gridColumns(['200', 'Auto', '*'], 250, [0, 100, 0])).toEqual([200, 100, 0])
})
test('works without any star column', () => {
  expect(gridColumns(['Auto', '100'], 1000, [30, 0])).toEqual([30, 100])
})
test('the Auto/* example from the lesson', () => {
  expect(gridColumns(['Auto', '*', '2*'], 700, [100, 0, 0])).toEqual([100, 200, 400])
})
```
:::

### DockPanel: edges first, the rest in the middle

Each child docks to an edge with `DockPanel.Dock="Top|Bottom|Left|Right"`, in the order you write
them. The **last child fills the remaining space** (`LastChildFill` is `true` by default). This is
the classic app shell:

```xml
<DockPanel>
  <Menu DockPanel.Dock="Top" />           <!-- 1. takes the top strip -->
  <Border DockPanel.Dock="Bottom" />      <!-- 2. status bar at the bottom -->
  <ListBox DockPanel.Dock="Left" Width="200" />  <!-- 3. sidebar -->
  <ContentControl />                      <!-- 4. fills what's left -->
</DockPanel>
```

Order matters: an element docked first gets the full edge, so swap 1 and 3 and the sidebar runs the
full height with the menu beside it. MAUI has no DockPanel; use a `Grid` with Auto/`*` rows instead.

### WrapPanel: flow onto the next line

Lays children out left to right and **wraps** onto a new line when the row is full, like words in a
paragraph. Perfect for tags, chips and toolbars that must survive a narrow window.

```xml
<WrapPanel>
  <Border Padding="8,2" Margin="0,0,6,6" Background="LightBlue"><TextBlock Text="react" /></Border>
  <Border Padding="8,2" Margin="0,0,6,6" Background="LightBlue"><TextBlock Text="csharp" /></Border>
</WrapPanel>
```

In MAUI the equivalent is `FlexLayout Wrap="Wrap"`.

### UniformGrid: every cell the same size

Splits the space into `Rows` × `Columns` equal cells, filling them in order. Leave one of the two
unset and it is calculated from the number of children. Good for dashboards, keypads and tile grids.

```xml
<UniformGrid Columns="3">
  <Button Content="1" /> <Button Content="2" /> <Button Content="3" />
  <Button Content="4" /> <Button Content="5" /> <Button Content="6" />
</UniformGrid>
```

### Canvas: absolute coordinates

Places children at exact positions with `Canvas.Left` / `Canvas.Top` (or `Right`/`Bottom`). Nothing
resizes, nothing wraps. Use it for drawings, diagrams, games and drag-and-drop surfaces, **never for
forms**: a form on a Canvas breaks as soon as a font or a translation changes. MAUI's version is
`AbsoluteLayout`.

```xml
<Canvas Width="200" Height="120" Background="WhiteSmoke">
  <Ellipse Canvas.Left="20" Canvas.Top="30" Width="40" Height="40" Fill="Gold" />
  <TextBlock Canvas.Left="70" Canvas.Top="40" Text="Treasure!" />
</Canvas>
```

| Need | Panel |
| --- | --- |
| Short vertical form, a row of buttons, the inside of a list item | `StackPanel` |
| Anything aligned in rows and columns; "this part takes the rest" | `Grid` |
| App shell: header, footer, sidebar, content | `DockPanel` (or Grid) |
| Tags, chips, toolbars that should wrap | `WrapPanel` |
| Equal tiles | `UniformGrid` |
| Free positioning, drawings | `Canvas` |

:::quiz id=dsk-04-q4 xp=10
QuestBoard shows a row of tag chips (`react`, `sql`, `docker`, …). When the window gets narrow, the
chips should continue on a second line instead of being cut off. Which panel do you use?
- [ ] A horizontal `StackPanel`
- [x] `WrapPanel`
- [ ] `Canvas`
- [ ] `UniformGrid` with `Columns="7"`
> `WrapPanel` moves children to the next line when a row is full. A horizontal `StackPanel` gives
> its children infinite width, so they keep going past the edge and get clipped. A `Canvas` uses
> fixed coordinates. A `UniformGrid` with 7 columns squeezes every chip into a narrower and narrower
> cell.
:::

:::quiz id=dsk-04-q5 xp=10
In this DockPanel, which element fills the large area in the middle?

```xml
<DockPanel>
  <Border DockPanel.Dock="Top" Height="48" />
  <ListBox DockPanel.Dock="Left" Width="200" />
  <TabControl />
  <Border DockPanel.Dock="Bottom" Height="24" />
</DockPanel>
```

- [ ] The `TabControl`, because it has no `DockPanel.Dock`
- [x] The bottom `Border`, because it's the last child, and `LastChildFill` ignores its `Dock` value
- [ ] The `ListBox`, because it's docked left
- [ ] None of them; DockPanel doesn't fill
> DockPanel processes children **in order** and the *last* child gets all the remaining space as its
> slot, whatever its `Dock` value says. Here that's the status bar (because it also has
> `Height="24"`, it shows as a 24 px strip centred in that big area). The `TabControl` has no `Dock`,
> so it defaults to `Left` and, with no width of its own, ends up 0 px wide. The fix is to put all
> docked children first and the fill child last, as in the QuestBoard lab below.
:::

## Scrolling and overflow

**Why:** content is often bigger than the window (long lists, long forms). Either the layout is
built so it can scroll, or content silently disappears past the edge. That's called **overflow**,
and the user simply can't reach the clipped part.

A `ScrollViewer` wraps one child, gives it as much space as it wants (infinite, in the scroll
direction), and shows scrollbars if the result is bigger than the viewer itself.

```xml
<ScrollViewer VerticalScrollBarVisibility="Auto">
  <StackPanel Spacing="8">
    <!-- a long settings form -->
  </StackPanel>
</ScrollViewer>
```

`ListBox` and other item lists already contain a ScrollViewer, but it only works if the list itself
gets a **limited** height.

:::warn title="The ListBox-in-a-StackPanel bug"
```xml
<StackPanel>
  <TextBlock Text="Quests" />
  <ListBox ItemsSource="{Binding Quests}" />   <!-- never scrolls! -->
</StackPanel>
```
The StackPanel offers the ListBox infinite height, so the ListBox makes itself as tall as all
its items. Its internal ScrollViewer sees nothing to scroll, and the bottom items fall off the
window. **Fix:** use a `Grid RowDefinitions="Auto,*"` and put the ListBox in the `*` row. A star
row has a definite height, so the list can scroll.
:::

:::challenge id=dsk-04-c3 lang=ts xp=40
title: Layout overflow detector
Write `stackOverflow(available, items)` for a vertical StackPanel that is `available` pixels tall.

Each item takes up `size + 2 * margin` pixels (`margin` is the same on top and bottom; it defaults
to `0`). Items are stacked from the top in order. Return:

- `total`: the height the stack wants (the sum of all items),
- `overflow`: how many pixels don't fit (`0` if everything fits),
- `clipped`: the names of items whose bottom edge is below `available`, in order (an item
  that ends exactly at `available` still fits).

Example: `stackOverflow(250, [{ name: 'header', size: 50 }, { name: 'list', size: 400 }])` →
`{ total: 450, overflow: 200, clipped: ['list'] }`.

hint: Keep a running `offset`; each item ends at `offset + size + 2 * margin`.
hint: An item is clipped when its end is `> available`. Use `?? 0` for the missing margin.

```ts starter
type Item = { name: string; size: number; margin?: number }

export function stackOverflow(available: number, items: Item[]): { total: number; overflow: number; clipped: string[] } {
  // your code
  return { total: 0, overflow: 0, clipped: [] }
}
```

```ts solution
type Item = { name: string; size: number; margin?: number }

export function stackOverflow(available: number, items: Item[]): { total: number; overflow: number; clipped: string[] } {
  let offset = 0
  const clipped: string[] = []
  for (const item of items) {
    offset += item.size + 2 * (item.margin ?? 0)
    if (offset > available) clipped.push(item.name)
  }
  return { total: offset, overflow: Math.max(0, offset - available), clipped }
}
```

```ts tests
test('everything fits', () => {
  expect(stackOverflow(300, [{ name: 'a', size: 100 }, { name: 'b', size: 100 }]))
    .toEqual({ total: 200, overflow: 0, clipped: [] })
})
test('a tall list pushes later items out of view', () => {
  const items = [{ name: 'header', size: 50 }, { name: 'list', size: 400 }, { name: 'footer', size: 30 }]
  expect(stackOverflow(250, items)).toEqual({ total: 480, overflow: 230, clipped: ['list', 'footer'] })
})
test('margins count twice and an exact fit is not clipped', () => {
  const items = [{ name: 'a', size: 40, margin: 5 }, { name: 'b', size: 40, margin: 5 }]
  expect(stackOverflow(100, items)).toEqual({ total: 100, overflow: 0, clipped: [] })
  expect(stackOverflow(99, items)).toEqual({ total: 100, overflow: 1, clipped: ['b'] })
})
test('an empty stack wants nothing', () => {
  expect(stackOverflow(100, [])).toEqual({ total: 0, overflow: 0, clipped: [] })
})
```
:::

## Everyday controls

**Why learn them as a set:** most business screens are built from about ten controls. Know what
each one is for, its key property and how it binds, and you can read almost any XAML file at work.
(Binding with `{Binding …}` and `x:DataType` is covered in depth in **Data Binding & MVVM**, the
next lesson; here we only use it.)

| Control | What it's for | Key properties |
| --- | --- | --- |
| `TextBlock` | Read-only text | `Text`, `TextWrapping`, `TextTrimming` |
| `TextBox` | Text input | `Text`, `PlaceholderText` (hint shown when empty), `AcceptsReturn` (multi-line) |
| `Button` | Run an action | `Content`, `Command`, `IsDefault` (Enter), `IsCancel` (Escape) |
| `CheckBox` | Yes/no | `IsChecked` (`true`/`false`/`null` with `IsThreeState`) |
| `ComboBox` | Pick one from a drop-down | `ItemsSource`, `SelectedItem` |
| `ListBox` | A list where the user can **select** items | `ItemsSource`, `SelectedItem`, `SelectionMode`, `ItemTemplate` |
| `ItemsControl` | Repeat a template for every item, **no selection** | `ItemsSource`, `ItemTemplate`, `ItemsPanel` |
| `TabControl` / `TabItem` | Pages behind tabs | `Header`, `SelectedIndex` |
| `ScrollViewer` | Make one child scrollable | `HorizontalScrollBarVisibility`, `VerticalScrollBarVisibility` |
| `Border` | Background, border, corner radius and padding around one child | `Background`, `BorderBrush`, `CornerRadius`, `Padding` |

Small examples:

```xml
<TextBox Text="{Binding NewTitle}" PlaceholderText="New quest title" />
<CheckBox Content="Show completed" IsChecked="{Binding ShowDone}" />
<ComboBox ItemsSource="{Binding Regions}" SelectedItem="{Binding SelectedRegion}" />
<Button Content="Add quest" Command="{Binding AddQuestCommand}" IsDefault="True" />
```

### Lists and DataTemplates

A list control doesn't know what a `Quest` looks like. You tell it with a **DataTemplate**: a small
piece of XAML that is created once per item, with that item as its `DataContext` (the object that
`{Binding}` reads from). `x:DataType` on the template says which type the item is, so the bindings
are **compiled** and checked at build time: a typo in `{Binding Titel}` becomes a build error
instead of a silently empty label.

```xml
<ListBox ItemsSource="{Binding Quests}">
  <ListBox.ItemTemplate>
    <DataTemplate x:DataType="m:Quest">
      <StackPanel Orientation="Horizontal" Spacing="8">
        <CheckBox IsChecked="{Binding Done}" />
        <TextBlock Text="{Binding Title}" />
      </StackPanel>
    </DataTemplate>
  </ListBox.ItemTemplate>
</ListBox>
```

`ItemsControl` is the base idea without selection, and `ItemsPanel` lets you change *how* the items
are laid out. Here are tags flowing in a WrapPanel:

```xml
<ItemsControl ItemsSource="{Binding Tags}">
  <ItemsControl.ItemsPanel>
    <ItemsPanelTemplate><WrapPanel /></ItemsPanelTemplate>
  </ItemsControl.ItemsPanel>
  <ItemsControl.ItemTemplate>
    <DataTemplate x:DataType="x:String">
      <Border Padding="8,2" Margin="0,0,6,6" CornerRadius="10" Background="LightBlue">
        <TextBlock Text="{Binding}" />   <!-- {Binding} alone = the item itself -->
      </Border>
    </DataTemplate>
  </ItemsControl.ItemTemplate>
</ItemsControl>
```

:::tip title="Virtualization"
`ListBox` reuses item containers for rows that are off screen (**virtualization**), so 10 000 quests
stay fast. An `ItemsControl` with a `WrapPanel`, or any list inside a StackPanel or ScrollViewer
that gives it infinite height, creates **every** item. Fine for 20 tags, slow for 10 000 rows.
:::

:::quiz id=dsk-04-q6 xp=10
You show QuestBoard's tags as read-only chips. The user never selects one. Which is the better fit?
- [ ] `ListBox`, because it's the only control that has `ItemTemplate`
- [x] `ItemsControl` with a `WrapPanel` as its `ItemsPanel`
- [ ] A `ComboBox`
- [ ] A `TabControl` with one tab per tag
> `ItemsControl` repeats a template per item without selection, focus highlighting or keyboard
> selection. That's exactly a list of chips. `ListBox` adds selection, which would make the chips
> look and behave clickable. Both support `ItemTemplate` and `ItemsPanel`.
:::

:::quiz id=dsk-04-q7 xp=10
What does `x:DataType="m:Quest"` on a `DataTemplate` give you?
- [ ] It creates a new `Quest` object for every row
- [x] Compiled bindings: `{Binding Title}` is checked against `Quest` at build time and runs without reflection
- [ ] It sorts the list by `Quest`
- [ ] Nothing; it's only a comment for the designer
> `x:DataType` tells the XAML compiler the type of the `DataContext`. Bindings are then compiled:
> a misspelled property fails the build, and at runtime there is no reflection lookup, so binding is
> faster. The items themselves still come from `ItemsSource`.
:::

## Responsive layouts

**Why:** desktop windows get resized, docked to half the screen and moved between 4K and laptop
monitors. Mobile apps rotate. A responsive layout adapts instead of clipping. Mostly you get this
from the panels themselves, and only sometimes from explicit rules.

From cheapest to most powerful:

1. **Let panels do it.** Star columns grow and shrink, `WrapPanel` wraps, `TextTrimming="CharacterEllipsis"`
   shortens long titles with "…", and `TextWrapping="Wrap"` wraps text.
2. **Limits instead of sizes.** `MinWidth` on the window and on inputs, `MaxWidth` on reading
   content so lines don't become 300 characters long on a wide monitor.
3. **Scroll as a fallback.** Wrap long forms in a `ScrollViewer` so nothing becomes unreachable.
4. **Container queries** (Avalonia 11.1+). They work like CSS container queries: a styles block
   that only applies while a named container is narrower or wider than a value. Unlike a check on the
   window size, the rule follows the size of a part of the layout.

```xml
<Window.Styles>
  <Style Selector="UniformGrid#StatsGrid">
    <Setter Property="Columns" Value="2" />
  </Style>
  <ContainerQuery Name="shell" Query="max-width:600">
    <Style Selector="UniformGrid#StatsGrid">
      <Setter Property="Columns" Value="1" />
    </Style>
  </ContainerQuery>
</Window.Styles>

<DockPanel Container.Name="shell" Container.Sizing="Width">
  ...
  <UniformGrid x:Name="StatsGrid"> ... </UniformGrid>
</DockPanel>
```

`Container.Sizing="Width"` makes the DockPanel a container that reports its width. While it's at
most 600 px wide, the stats tiles drop to one column.

:::warn title="Local values beat styles"
If you write `<UniformGrid Columns="2">`, the container query can never change it, because a value
set directly on a control (a **local value**) has higher priority than any style. Put the default
in a style too, as above.
:::

:::info title="In .NET MAUI"
MAUI's tools are `Grid`, `VerticalStackLayout`/`HorizontalStackLayout`, `FlexLayout` (wrapping),
`AbsoluteLayout`, the `OnIdiom` / `OnPlatform` markup extensions (different values for phone,
tablet and desktop) and `AdaptiveTrigger` in the VisualStateManager (`MinWindowWidth`). The
ideas are the same: let panels flex first, switch layouts only where needed.
:::

:::quiz id=dsk-04-q8 xp=10
Your container query should switch the stats tiles to one column, but they stay at two. The XAML is
`<UniformGrid x:Name="StatsGrid" Columns="2">`. Why?
- [ ] Container queries only work on `Grid`
- [x] `Columns="2"` is a local value, and local values take priority over styles, including container-query styles
- [ ] The query must be written in C#
- [ ] `UniformGrid` can't have one column
> A property set directly on the element wins over any style setter. Move the default
> (`Columns = 2`) into a normal style and let the container query override it. This priority order
> is the same in WPF and MAUI, and it's a common "why doesn't my style apply?" bug.
:::

## Accessibility: keyboard and screen readers

**Why:** some of your users can't use a mouse, can't see the screen, or simply prefer the keyboard
(most power users do). Many employers and public-sector customers also *require* accessibility
(in the EU, the European Accessibility Act applies from June 2025). Getting it right in the layout
costs little. Fixing it afterwards costs a lot.

**Screen readers** (Narrator on Windows, VoiceOver on macOS, Orca on Linux) don't see pixels. They
read the **automation tree**, a description of each control (its role, name, value and state) that
the framework produces. Your job is to make sure every control has a sensible **name**.

- A `Button` with text content gets its name from the text automatically.
- An icon-only button (a `PathIcon` or image inside), a `TextBox`, a `ComboBox` or a `ListBox` has
  **no** name unless you give it one. (An emoji used as text is no better: the screen reader reads
  its Unicode name, such as "wastebasket", which says nothing about what the button does.)

```xml
<Button Command="{Binding DeleteCommand}"
        AutomationProperties.Name="Delete quest" ToolTip.Tip="Delete quest">
  <PathIcon Data="{StaticResource DeleteIconGeometry}" />  <!-- a vector icon from your resources -->
</Button>

<TextBox Text="{Binding NewTitle}" AutomationProperties.Name="New quest title" />

<!-- or name it from a visible label -->
<Label x:Name="TitleLabel" Content="_Title" Target="{Binding #TitleBox}" />
<TextBox x:Name="TitleBox" AutomationProperties.LabeledBy="{Binding #TitleLabel}" />
```

(`{Binding #TitleBox}` is Avalonia's short syntax for "the element named TitleBox". `Target` also
makes Alt+T move focus to the box. A placeholder
text is *not* a label: it disappears as soon as the user types.) In MAUI the equivalent property is
`SemanticProperties.Description`.

**Keyboard focus** is which control receives key presses. Tab moves focus forward, Shift+Tab back,
in the order the controls appear in the tree. That's usually right if your XAML is in reading order.
Tools to adjust it:

| Property | Effect |
| --- | --- |
| `IsTabStop="False"` | Skip this control when tabbing (still clickable). |
| `TabIndex="1"` | Change the order. Use it rarely; reordering the XAML is cleaner. |
| `KeyboardNavigation.TabNavigation="Cycle"` | Tab stays inside a container (dialogs). |
| `IsDefault="True"` on a Button | Enter presses it. |
| `IsCancel="True"` on a Button | Escape presses it. |
| `Content="_Add quest"` | Access key: Alt+A presses the button (the underscore marks the letter). |

Also check that the **focus indicator** is visible (don't style it away), and never use colour as
the only signal: a red border alone doesn't help a colour-blind user, so add an icon or text.

:::quiz id=dsk-04-q9 xp=15
Which of these controls need `AutomationProperties.Name` (or a label) so a screen reader can
announce them? Select all that apply.
- [x] A button whose only content is a trash-can `PathIcon`
- [x] A `TextBox` with only a placeholder text "Search quests"
- [ ] `<Button Content="Save" />`
- [x] A `ComboBox` for choosing the region, with no label next to it
> Text content becomes the accessible name automatically, so `Content="Save"` is fine. An icon has
> no text, a placeholder is not a name (and disappears once the user types), and a ComboBox doesn't
> name itself after its selected value. All three would be read out as just "button", "edit" or
> "combo box".
:::

:::job title="What you'll meet at work"
Most desktop codebases have one or two "big" screens with a deeply nested Grid that nobody dares to
touch. Your first tickets will often be "this is cut off at 125 % scaling" or "the list doesn't
scroll". Open the app's developer tools to inspect the visual tree, check every control's `Bounds` and
`DesiredSize`, and find which parent hands out infinite space. In Avalonia, press **F12** in a debug
build (setup in **Your First Avalonia App**).
Expect accessibility bugs ("Narrator says 'button button button'") in the same
backlog.
:::

:::pro title="How seniors structure layout"
- **Shallow trees.** One Grid with Auto/`*` rows beats five nested StackPanels: it's easier to read
  and faster to lay out.
- **No magic numbers.** Spacing comes from shared resources or styles (`Margin="{StaticResource
  GapM}"`), not 7 px here and 9 px there.
- **Test layout headlessly.** Avalonia's headless platform runs measure and arrange without a
  screen, so CI can assert "the input fills the leftover width" or "every input has a name". You'll
  do exactly that in the lab.
- **Check at 375 px and 200 % zoom** before calling a screen done.
:::

## Lab: lay out the QuestBoard window

:::lab id=dsk-04-lab1 xp=100
title: QuestBoard layout with headless layout tests
You'll replace the template's "Welcome" window with the real QuestBoard layout: a DockPanel shell, a
Grid form, wrapping tags, a scrolling quest list, a stats tab with a container query, and keyboard
and screen-reader support. Then you'll prove it with headless UI tests. Works on Windows, macOS and
Linux. Needs the .NET 10 SDK.

:::info
Verified with the template's **Avalonia 12.1.5** and **CommunityToolkit.Mvvm 8.4.2**. If your
template creates an **11.x** project, use `Watermark=` instead of `PlaceholderText=` and set the
`Avalonia.Headless.XUnit` version to your Avalonia version (11.x uses xUnit v2: replace `xunit.v3`
with `xunit` 2.9.3 and remove `<OutputType>Exe</OutputType>`).
:::

**1. Create the project** (skip the first command if you installed the templates in an earlier
lesson):

```bash
dotnet new install Avalonia.Templates
mkdir questboard-layout && cd questboard-layout
dotnet new avalonia.mvvm -o QuestBoard
cd QuestBoard
dotnet run
```

A window with a text box saying "Welcome to Avalonia!" opens. Close it.

**2. Add the model.** Create `QuestBoard/Models/Quest.cs`:

```csharp
namespace QuestBoard.Models;

public class Quest
{
    public required string Title { get; init; }
    public required string Region { get; init; }
    public int Xp { get; init; }
    public bool Done { get; set; }
}
```

**3. Replace the view model.** Replace all of `QuestBoard/ViewModels/MainViewModel.cs`:

```csharp
using System.Collections.ObjectModel;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using QuestBoard.Models;

namespace QuestBoard.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    public string[] Regions { get; } = ["Frontend", "Backend", "Database", "Ops"];

    public string[] Tags { get; } = ["react", "csharp", "sql", "docker", "xaml", "testing", "git"];

    public ObservableCollection<Quest> Quests { get; } =
    [
        new Quest { Title = "Build a Grid layout", Region = "Frontend", Xp = 40 },
        new Quest { Title = "Write a Minimal API", Region = "Backend", Xp = 60, Done = true },
        new Quest { Title = "Index the orders table", Region = "Database", Xp = 30 },
    ];

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddQuestCommand))]
    public partial string NewTitle { get; set; } = "";

    [ObservableProperty]
    public partial string SelectedRegion { get; set; } = "Frontend";

    public int TotalXp => Quests.Where(q => q.Done).Sum(q => q.Xp);

    private bool CanAddQuest() => !string.IsNullOrWhiteSpace(NewTitle);

    [RelayCommand(CanExecute = nameof(CanAddQuest))]
    private void AddQuest()
    {
        Quests.Add(new Quest { Title = NewTitle.Trim(), Region = SelectedRegion, Xp = 25 });
        NewTitle = "";
    }
}
```

`[ObservableProperty]` and `[RelayCommand]` are CommunityToolkit.Mvvm source generators. They
generate the property change notification and the `AddQuestCommand` (disabled while the title is
empty). **Data Binding & MVVM** explains them in detail. (`TotalXp` doesn't update yet when you tick a quest,
because `Quest` doesn't send change notifications. That's fixed in **Data Binding & MVVM**.)

**4. Replace the window.** Replace all of `QuestBoard/Views/MainWindow.axaml`:

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.ViewModels"
        xmlns:m="using:QuestBoard.Models"
        x:Class="QuestBoard.Views.MainWindow"
        x:DataType="vm:MainViewModel"
        Icon="/Assets/avalonia-logo.ico"
        Title="QuestBoard"
        Width="900" Height="600" MinWidth="360" MinHeight="400">

    <Design.DataContext>
        <vm:MainViewModel />
    </Design.DataContext>

    <!-- Responsive rules: the DockPanel is a "container" whose width styles can query -->
    <Window.Styles>
        <Style Selector="UniformGrid#StatsGrid">
            <Setter Property="Columns" Value="2" />
        </Style>
        <ContainerQuery Name="shell" Query="max-width:600">
            <Style Selector="UniformGrid#StatsGrid">
                <Setter Property="Columns" Value="1" />
            </Style>
            <Style Selector="ItemsControl#TagList">
                <Setter Property="IsVisible" Value="False" />
            </Style>
        </ContainerQuery>
    </Window.Styles>

    <!-- DockPanel: header on top, status bar at the bottom, the last child fills the rest -->
    <DockPanel Container.Name="shell" Container.Sizing="Width">

        <!-- Header: Grid with an Auto column (logo), a * column (title) and an Auto column (XP) -->
        <Grid DockPanel.Dock="Top" ColumnDefinitions="Auto,*,Auto"
              Background="#1f2937" Height="56">
            <TextBlock Grid.Column="0" Text="⚔" FontSize="24" Foreground="White"
                       VerticalAlignment="Center" Margin="16,0,8,0" />
            <TextBlock Grid.Column="1" Text="QuestBoard" FontSize="20" FontWeight="SemiBold"
                       Foreground="White" VerticalAlignment="Center" />
            <TextBlock Grid.Column="2" Foreground="#fbbf24" FontWeight="Bold"
                       VerticalAlignment="Center" Margin="8,0,16,0"
                       Text="{Binding TotalXp, StringFormat='{}{0} XP'}" />
        </Grid>

        <!-- Status bar -->
        <Border DockPanel.Dock="Bottom" Background="#e5e7eb" Padding="16,4">
            <TextBlock Text="{Binding Quests.Count, StringFormat='{}{0} quests'}" FontSize="12" />
        </Border>

        <!-- Fills the remaining space -->
        <TabControl x:Name="Tabs" Margin="8">
            <TabItem Header="Board">
                <Grid RowDefinitions="Auto,Auto,*" Margin="0,8,0,0">

                    <!-- Add-quest form: the TextBox column takes all leftover width -->
                    <Grid Grid.Row="0" ColumnDefinitions="*,Auto,Auto" Margin="0,0,0,8">
                        <TextBox x:Name="NewTitleBox" Grid.Column="0" Text="{Binding NewTitle}"
                                 PlaceholderText="New quest title"
                                 AutomationProperties.Name="New quest title" />
                        <ComboBox x:Name="RegionBox" Grid.Column="1" Margin="8,0" MinWidth="120"
                                  ItemsSource="{Binding Regions}"
                                  SelectedItem="{Binding SelectedRegion}"
                                  AutomationProperties.Name="Region" />
                        <Button x:Name="AddButton" Grid.Column="2" Content="_Add quest" IsDefault="True"
                                Command="{Binding AddQuestCommand}" />
                    </Grid>

                    <!-- Tags wrap onto a new line when the window gets narrow -->
                    <ItemsControl x:Name="TagList" Grid.Row="1" ItemsSource="{Binding Tags}" Margin="0,0,0,8">
                        <ItemsControl.ItemsPanel>
                            <ItemsPanelTemplate>
                                <WrapPanel />
                            </ItemsPanelTemplate>
                        </ItemsControl.ItemsPanel>
                        <ItemsControl.ItemTemplate>
                            <DataTemplate x:DataType="x:String">
                                <Border Background="#dbeafe" CornerRadius="10"
                                        Padding="10,2" Margin="0,0,6,6">
                                    <TextBlock Text="{Binding}" FontSize="12" />
                                </Border>
                            </DataTemplate>
                        </ItemsControl.ItemTemplate>
                    </ItemsControl>

                    <!-- The list: a * row, so it gets a fixed height and can scroll -->
                    <ListBox x:Name="QuestList" Grid.Row="2" ItemsSource="{Binding Quests}"
                             AutomationProperties.Name="Quests">
                        <ListBox.ItemTemplate>
                            <DataTemplate x:DataType="m:Quest">
                                <Grid ColumnDefinitions="Auto,*,Auto">
                                    <CheckBox Grid.Column="0" IsChecked="{Binding Done}"
                                              AutomationProperties.Name="{Binding Title}" />
                                    <StackPanel Grid.Column="1" Margin="8,0" VerticalAlignment="Center">
                                        <TextBlock Text="{Binding Title}" FontWeight="SemiBold"
                                                   TextTrimming="CharacterEllipsis" />
                                        <TextBlock Text="{Binding Region}" FontSize="12" Opacity="0.7" />
                                    </StackPanel>
                                    <TextBlock Grid.Column="2" VerticalAlignment="Center"
                                               Text="{Binding Xp, StringFormat='+{0} XP'}" />
                                </Grid>
                            </DataTemplate>
                        </ListBox.ItemTemplate>
                    </ListBox>
                </Grid>
            </TabItem>

            <TabItem Header="Stats">
                <ScrollViewer>
                    <!-- UniformGrid: every cell the same size -->
                    <UniformGrid x:Name="StatsGrid" Margin="0,8,0,0">
                        <Border Background="#dcfce7" Margin="4" Padding="16" CornerRadius="8">
                            <TextBlock Text="{Binding TotalXp, StringFormat='XP earned: {0}'}" />
                        </Border>
                        <Border Background="#fef3c7" Margin="4" Padding="16" CornerRadius="8">
                            <TextBlock Text="{Binding Quests.Count, StringFormat='Quests: {0}'}" />
                        </Border>
                        <Border Background="#e0e7ff" Margin="4" Padding="16" CornerRadius="8">
                            <TextBlock Text="{Binding Regions.Length, StringFormat='Regions: {0}'}" />
                        </Border>
                        <Border Background="#fce7f3" Margin="4" Padding="16" CornerRadius="8">
                            <TextBlock Text="Streak: 3 days" />
                        </Border>
                    </UniformGrid>
                </ScrollViewer>
            </TabItem>
        </TabControl>
    </DockPanel>
</Window>
```

**5. Run it:**

```bash
dotnet run
```

Expected: a dark header with "QuestBoard" and "60 XP", tabs **Board** and **Stats**, a form, seven
tag chips, three quests and a "3 quests" status bar. Try this:

- Make the window narrower. The title box shrinks and the button stays visible. Below 600 px the tags
  disappear, and on the Stats tab the tiles become a single column.
- Click in the title box, type `Ship QuestBoard` and press **Enter** (`IsDefault`). A fourth quest
  appears and the status bar says "4 quests". Add ten more: the list scrolls, because it sits in a
  `*` row.
- Press **Tab** repeatedly. Focus goes title box → region → button → quest list, in reading order. **Alt+A**
  presses "Add quest".

**6. Add headless layout tests.** Go back up to the `questboard-layout` folder and create a test
project folder next to `QuestBoard`:

```bash
cd ..
mkdir QuestBoard.Tests
```

Create `QuestBoard.Tests/QuestBoard.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Avalonia.Headless.XUnit" Version="12.1.5" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.1" />
    <PackageReference Include="xunit.v3" Version="3.2.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\QuestBoard\QuestBoard.csproj" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

</Project>
```

Create `QuestBoard.Tests/TestAppBuilder.cs`. It starts your `App` on Avalonia's headless platform
(no window on screen, but real measure and arrange):

```csharp
using Avalonia;
using Avalonia.Headless;

[assembly: AvaloniaTestApplication(typeof(QuestBoard.Tests.TestAppBuilder))]

namespace QuestBoard.Tests;

public class TestAppBuilder
{
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>().UseHeadless(new AvaloniaHeadlessPlatformOptions());
}
```

Create `QuestBoard.Tests/LayoutTests.cs`:

```csharp
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Headless.XUnit;
using QuestBoard.ViewModels;
using QuestBoard.Views;

namespace QuestBoard.Tests;

public class LayoutTests
{
    private static (MainWindow window, MainViewModel vm) Open()
    {
        var vm = new MainViewModel();
        var window = new MainWindow { DataContext = vm };
        window.Show(); // runs a measure + arrange pass in the headless platform
        return (window, vm);
    }

    [AvaloniaTheory]
    [InlineData("NewTitleBox")]
    [InlineData("RegionBox")]
    [InlineData("QuestList")]
    public void Input_has_an_accessible_name(string name)
    {
        var (window, _) = Open();
        var control = window.FindControl<Control>(name);

        Assert.NotNull(control);
        Assert.False(string.IsNullOrWhiteSpace(AutomationProperties.GetName(control)));
    }

    [AvaloniaFact]
    public void Title_box_takes_the_leftover_width()
    {
        var (window, _) = Open();
        var box = window.FindControl<TextBox>("NewTitleBox")!;

        // 900 px window: the * column gets everything the Auto columns don't need
        Assert.True(box.Bounds.Width > 500, $"TextBox is only {box.Bounds.Width} px wide");
    }

    [AvaloniaFact]
    public void Add_button_is_disabled_until_a_title_is_typed()
    {
        var (window, vm) = Open();
        var add = window.FindControl<Button>("AddButton")!;

        Assert.False(add.IsEffectivelyEnabled);
        vm.NewTitle = "Ship QuestBoard";
        Assert.True(add.IsEffectivelyEnabled);

        add.Command!.Execute(null);
        Assert.Equal(4, vm.Quests.Count);
        Assert.Equal("", vm.NewTitle);
    }

    [AvaloniaTheory]
    [InlineData(900, 2, true)]
    [InlineData(480, 1, false)]
    public void Layout_adapts_to_the_window_width(double width, int columns, bool tagsVisible)
    {
        var (window, _) = Open();
        window.Width = width;
        window.UpdateLayout(); // container queries are re-evaluated during layout
        Assert.Equal(tagsVisible, window.FindControl<ItemsControl>("TagList")!.IsVisible);

        window.FindControl<TabControl>("Tabs")!.SelectedIndex = 1; // switch to the Stats tab
        window.UpdateLayout();
        Assert.Equal(columns, window.FindControl<UniformGrid>("StatsGrid")!.Columns);
    }
}
```

**7. Run the tests:**

```bash
cd QuestBoard.Tests
dotnet test
```

Expected last line (the duration will differ):

```text
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7, Duration: 941 ms - QuestBoard.Tests.dll (net10.0)
```

**8. Break it on purpose** to see the tests guard your layout. In `MainWindow.axaml`, change the form's
`ColumnDefinitions="*,Auto,Auto"` to `"Auto,Auto,Auto"`, and run `dotnet test` again:
`Title_box_takes_the_leftover_width` fails, because the TextBox now hugs its placeholder. Delete
`AutomationProperties.Name="Region"` and the accessibility test fails. Put both back.

:::tip
Optional: start your OS screen reader (Narrator: Win+Ctrl+Enter, VoiceOver: Cmd+F5, Orca: Super+Alt+S)
and Tab through the window. You should hear "New quest title, edit", "Region, combo box" and the
quest titles on the checkboxes.
:::

- [ ] `dotnet run` shows the QuestBoard layout with header, tabs, form, tags, list and status bar
- [ ] Narrowing the window below 600 px hides the tags and makes the stats a single column
- [ ] Enter adds a quest, and the list scrolls once it is longer than the window
- [ ] Tab order is title, region, button, list, and Alt+A presses "Add quest"
- [ ] `dotnet test` reports 7 passed, 0 failed
- [ ] Breaking the star column or removing an accessible name makes a test fail
:::

:::cards id=dsk-04-cards1 xp=15 title="XAML layout & controls"
Q: What are the two phases of a layout pass?
A: Measure (parents offer an available size, children report a DesiredSize) and arrange (parents assign each child its final slot).
Q: Why doesn't a ListBox inside a vertical StackPanel scroll?
A: The StackPanel offers it infinite height, so it grows to fit all items and its ScrollViewer has nothing to scroll. Put it in a Grid `*` row.
Q: Auto vs * vs 120 in a Grid?
A: 120 = exact pixels; Auto = size of the largest child; * = a share of the leftover space after pixel and Auto (2* gets twice a share).
Q: Margin vs Padding?
A: Margin is space outside the border (to neighbours); Padding is space inside the border (around the content).
Q: Which DockPanel child fills the middle?
A: The last child (LastChildFill = true), whatever its Dock value.
Q: ItemsControl vs ListBox?
A: Both repeat an ItemTemplate per item; ListBox adds selection and virtualization. ItemsControl is for display-only lists.
Q: What does x:DataType on a DataTemplate do?
A: Enables compiled bindings: property names are checked at build time and bound without reflection.
Q: When is Canvas the right panel?
A: Drawings, diagrams, games, drag-and-drop surfaces. Never forms.
Q: How do you name an icon-only button for a screen reader?
A: AutomationProperties.Name="Delete quest" (MAUI: SemanticProperties.Description).
Q: What do IsDefault, IsCancel and "_Add" do on a Button?
A: Enter presses it, Escape presses it, and Alt+A presses it (access key).
Q: Why doesn't my container-query style change a property?
A: A local value set on the element beats every style. Move the default into a style.
:::

## Recap

- Layout is two phases: **measure** (available size in, `DesiredSize` out) and **arrange** (each
  child gets its final slot). Infinite available space explains most "doesn't scroll" bugs.
- Alignment, `Margin` (outside) and `Padding` (inside) decide what a control does in its slot;
  prefer `Min`/`Max` sizes over fixed `Width`/`Height`.
- Pick panels by rule: `StackPanel` for lines, `Grid` (pixel / `Auto` / `*`) for rows and columns,
  `DockPanel` for shells, `WrapPanel` for chips, `UniformGrid` for tiles, `Canvas` for drawings.
- Lists use `ItemsSource` + a `DataTemplate` with `x:DataType` for compiled bindings; `ListBox`
  selects and virtualizes, `ItemsControl` only displays.
- Responsive = flexible panels first, then `Min`/`Max`, scrolling, and container queries; local
  values beat styles.
- Accessibility: give every input and icon button an `AutomationProperties.Name`, keep XAML in
  reading order for Tab, and use `IsDefault`, `IsCancel` and access keys.
- Headless Avalonia tests can check layout and accessibility in CI.
