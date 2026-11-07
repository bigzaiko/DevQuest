---
id: dsk-06
title: Styles, Themes & Resources
level: intermediate
minutes: 90
xp: 150
summary: Give QuestBoard one consistent look with resources, Avalonia selector styles, ControlThemes and a light/dark switch driven by design tokens.
---

QuestBoard works. Now it needs to *look* like one product rather than a pile of controls. Picture this
ticket: *"Marketing changed the brand blue, and users want dark mode."* If every `Button` in the app has
`Background="#3559E0"` typed into it, that's a search-and-replace across 40 files, and you'll still
miss some. If the colour lives in **one named resource**, and styles and themes pick it up from there,
it's a one-line change.

This lesson covers the three tools XAML gives you for that:

| Tool | What it answers | Web analogy |
|---|---|---|
| **Resource** | "What *is* our accent colour / corner radius / icon?" | CSS custom property (`--accent`) |
| **Style** | "Which controls get which property values?" | CSS rule (`.card:hover { … }`) |
| **Theme** | "What does a control look like by default, and in light vs dark?" | Design system + `prefers-color-scheme` |

Examples use **Avalonia 12** (with the Fluent theme) and the QuestBoard app, plus short comparisons with
WPF and **.NET MAUI 10** so you can spot the same ideas at a job that uses those.

## Resources: named values you reuse

A **resource** is any object stored under a name (its **key**, set with `x:Key`) so you can use it
in many places. Colours, brushes, numbers, thicknesses, fonts, icon shapes and even whole templates
can be resources.

A **ResourceDictionary** is the container: a key → object map. Almost every element has one
(`Resources`), and so does the `Application`.

```xml
<Window.Resources>
  <SolidColorBrush x:Key="Brush.Accent" Color="#3559E0" />
  <CornerRadius x:Key="Radius.Card">10</CornerRadius>
  <x:Double x:Key="Font.Title">22</x:Double>
</Window.Resources>

<Border Background="{StaticResource Brush.Accent}"
        CornerRadius="{StaticResource Radius.Card}" />
```

Line by line:

- `x:Key="Brush.Accent"` is the name. Keys are case-sensitive strings. The dot is just a naming
  convention, not special syntax.
- `SolidColorBrush` is the object. In XAML you paint with **brushes**, not colours: a `Color` is a
  value (`#3559E0`), a brush is the thing that fills an area *with* that colour (or a gradient, or an image).
- `x:Double` is how you write a plain number as a resource (`x:` is the XAML language namespace).
- `{StaticResource Brush.Accent}` is a **markup extension**: the curly braces mean "don't use this
  text as the literal value, run a little lookup to compute it".

### Where does the lookup go? The resource chain

When a control asks for a key, Avalonia searches outward until something has it:

1. the control's own `Resources`,
2. each **parent** in the **logical tree** (the nesting you wrote in XAML: `Border` → `StackPanel` →
   `Window`…; the *visual* tree additionally contains the parts each control's template draws),
3. `Application.Resources`,
4. the theme's resources (`FluentTheme` provides hundreds, like `SystemAccentColor`).

The **nearest** definition wins. That lets you override a token for one area without touching the
rest of the app, the same way a CSS variable set on a `<section>` overrides the one on `:root`.

Inside **one** dictionary the order is:

1. its own entries,
2. its **theme dictionaries** for the active variant (`Light`/`Dark`, more below), falling back to `Default`,
3. its **merged dictionaries**, from the **last** one added to the first, so a later file overrides an earlier one.

**Merged dictionaries** let you split resources into files and pull them in:

```xml
<!-- Styles/Tokens.axaml : a file that is just a dictionary -->
<ResourceDictionary xmlns="https://github.com/avaloniaui"
                    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <SolidColorBrush x:Key="Brush.Danger" Color="#D93A3A" />
</ResourceDictionary>
```

```xml
<!-- App.axaml -->
<Application.Resources>
  <ResourceDictionary>
    <ResourceDictionary.MergedDictionaries>
      <ResourceInclude Source="avares://QuestBoard/Styles/Tokens.axaml" />
    </ResourceDictionary.MergedDictionaries>
  </ResourceDictionary>
</Application.Resources>
```

`avares://QuestBoard/...` is an **Avalonia resource URI**: "a file compiled into the assembly named
`QuestBoard`". `.axaml` files are compiled in automatically; images and fonts need an
`<AvaloniaResource Include="Assets\**" />` line in the `.csproj`.

:::quiz id=dsk-06-q1 xp=10
`Brush.Accent` is defined in `App.axaml` as blue **and** in the `Resources` of a `StackPanel` as
green. A `Button` inside that `StackPanel` uses `{DynamicResource Brush.Accent}`. What colour is it?
- [ ] Blue: the Application always wins
- [x] Green: the lookup starts at the control and walks up, so the nearest definition wins
- [ ] It's a compile error: duplicate key
- [ ] Whichever was defined last in the files
> Lookup walks outward from the control (own resources → parents → Application → theme), and stops at
> the first match. Duplicate keys are only an error *inside the same dictionary*; the same key in
> different scopes is how you override a token for one part of the UI.
:::

## StaticResource vs DynamicResource

Both look up a key. The difference is **when**.

- **`StaticResource`** looks once, while the XAML is loading, and copies the value in. It's fast and
  fails loudly if the key is missing. If the resource changes later, the control doesn't notice.
- **`DynamicResource`** subscribes. The control gets the current value now and **updates whenever
  the resource behind that key changes**: when the theme switches from Light to Dark, when you
  replace the value in code, or when the control moves under a parent with a different definition.

```xml
<!-- Never changes at runtime: StaticResource is fine -->
<Border CornerRadius="{StaticResource Radius.Card}" />

<!-- Differs per theme: must be DynamicResource -->
<Border Background="{DynamicResource Brush.Card}" />
```

Rule of thumb: **anything that depends on the theme → `DynamicResource`**. Sizes, spacing, icon
geometry and fonts can be `StaticResource`.

:::warn title="StaticResource + theme brushes = KeyNotFoundException"
In the lab below, changing one setter in a separate style file to `{StaticResource Brush.Surface}`
(a key that only exists inside the Light/Dark theme dictionaries) makes the app crash on startup with
`KeyNotFoundException: Static resource 'Brush.Surface' not found.` Where a static lookup *does* find a
themed brush (for example `Background="{StaticResource Brush.Card}"` directly in `MainWindow.axaml`),
it freezes the value of the theme active at load time: the card stays white after switching to dark,
and nothing reports an error. Both behaviours were checked with headless tests on Avalonia 11.3. When a
colour "won't switch", check for `StaticResource` first.
:::

:::quiz id=dsk-06-q2 xp=10
You add a dark mode. Most of the app switches, but one card stays bright white. Its XAML is
`Background="{StaticResource Brush.Card}"`. Why?
- [ ] `Brush.Card` isn't defined in the Dark dictionary
- [x] `StaticResource` resolved the brush once at load time and never looks again
- [ ] Borders don't support theme variants
- [ ] The card needs `x:DataType`
> A static lookup is a one-time copy. Theme switching works by swapping which dictionary answers the
> key, and only `DynamicResource` subscribes to that change. (If the key were missing from the Dark
> dictionary, a dynamic lookup would find nothing and the card would lose its background, not stay white.)
:::

## Styles: rules that set properties

Setting `CornerRadius`, `Padding`, `Background` on every card is repetitive. A **style** says "for
every control matching *this pattern*, set *these properties*". The pattern is a **selector**, and
each property assignment is a **setter**.

```xml
<Window.Styles>
  <Style Selector="Border.quest-card">
    <Setter Property="Background" Value="{DynamicResource Brush.Card}" />
    <Setter Property="CornerRadius" Value="{StaticResource Radius.Card}" />
    <Setter Property="Padding" Value="14,10" />
  </Style>
</Window.Styles>

<Border Classes="quest-card"> … </Border>
```

`Classes="quest-card"` gives the element a **style class**: a tag, like a CSS class. An element can
have several: `Classes="quest-card urgent"`.

If you know CSS, Avalonia selectors will feel familiar. That's on purpose:

| Selector | Matches |
|---|---|
| `Button` | every `Button` (exact type only; derived types such as `ToggleButton` are not included) |
| `:is(Button)` | `Button` **and** any type derived from it |
| `.accent` | any control with class `accent` |
| `Button.accent` | a `Button` with class `accent` |
| `#SaveButton` | the control with `Name="SaveButton"` (or `x:Name`) |
| `StackPanel > Button` | a `Button` whose **direct parent** is a `StackPanel` (child combinator) |
| `StackPanel Button` | a `Button` **anywhere inside** a `StackPanel` (descendant combinator) |
| `Button:pointerover` | a `Button` while the mouse is over it (pseudo-class, next section) |
| `Button /template/ ContentPresenter` | the `ContentPresenter` *inside* the Button's template |

Two Avalonia-only features are worth knowing:

**Conditional classes from a binding.** `Classes.done="{Binding IsDone}"` adds the class `done` while
`IsDone` is `true`, and removes it when it's `false`. This is how a view model drives the look
without knowing anything about colours:

```xml
<Style Selector="TextBlock.done">
  <Setter Property="TextDecorations" Value="Strikethrough" />
  <Setter Property="Opacity" Value="0.6" />
</Style>

<TextBlock Text="{Binding Title}" Classes.done="{Binding IsDone}" />
```

**Which style wins?** When two styles set the same property on the same control, Avalonia does
**not** use CSS-style specificity (where `#id` beats `.class` beats a type, no matter the order). It
asks three questions, in this order:

1. **Is it a trigger style?** A selector that contains a **class** (`.accent`) or a
   **pseudo-class** (`:pointerover`, more below) *anywhere*, even on an ancestor
   (`StackPanel.list Button`), can start or stop matching while the app runs, because classes and
   states change. Avalonia calls these **style triggers** and gives them a higher priority than plain
   styles (type, `#name`, `>` and descendant selectors with no class or pseudo-class). A trigger style
   beats a plain one **regardless of order or scope**.
2. **Which is closer to the control?** Within the same tier, styles in the control's own `Styles` beat
   its parents', which beat `Application.Styles`.
3. **Which was declared later?** Within one `Styles` collection and the same tier, the later style wins.

A value set directly on the element (`<Border Background="Red">`) beats every style.

```xml
<Style Selector="Button.accent"><Setter Property="Foreground" Value="Red" /></Style>
<Style Selector="Button"><Setter Property="Foreground" Value="Green" /></Style>
<!-- <Button Classes="accent" /> is RED: the class makes the first style a trigger,
     and triggers beat plain styles even when declared earlier. -->
```

This was checked with headless tests on Avalonia 11.3 and 12.1. Triggers having their own priority
is also why the theme's own `:pointerover` styles override a plain `Background` setter you wrote: they
are triggers, and yours isn't.

:::tip title="Where do styles live?"
`Application.Styles` (the whole app), `Window.Styles` / `UserControl.Styles` (one view), or a separate
`Styles` file pulled in with `<StyleInclude Source="avares://QuestBoard/Styles/QuestStyles.axaml" />`.
Real apps keep a `Styles/` folder and include it once in `App.axaml`.
:::

### How this differs from WPF (and MAUI)

WPF (and MAUI) have no selectors. A WPF style targets one **type**, optionally gets a key, and reacts
to state through **triggers**:

```xml
<!-- WPF -->
<Style x:Key="AccentButton" TargetType="Button">
  <Setter Property="Background" Value="{StaticResource AccentBrush}" />
  <Style.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter Property="Background" Value="DarkBlue" />
    </Trigger>
  </Style.Triggers>
</Style>
<Button Style="{StaticResource AccentButton}" />
```

The Avalonia version is two independent styles, with no trigger and no key:

```xml
<!-- Avalonia -->
<Style Selector="Button.accent">
  <Setter Property="Background" Value="{DynamicResource Brush.Accent}" />
</Style>
<Style Selector="Button.accent:pointerover /template/ ContentPresenter#PART_ContentPresenter">
  <Setter Property="Background" Value="DarkBlue" />
</Style>
```

- WPF `Style TargetType` + `x:Key` → Avalonia **selector + class**.
- WPF `Trigger` / `DataTrigger` → Avalonia **pseudo-class** or **conditional class** (`Classes.x="{Binding}"`).
- WPF implicit style (no key, applies to every Button) → an Avalonia `Style Selector="Button"` for
  small tweaks, or a **`ControlTheme`** (below) when you replace the control's whole look.
- **MAUI** is WPF-shaped: `<Style TargetType="Button">`, `StyleClass="accent"`, and state changes through
  the **VisualStateManager** (`Normal`, `PointerOver`, `Pressed`, `Disabled` states).

:::quiz id=dsk-06-q3 xp=10
Two styles in the **same** `Window.Styles`, in this order:

```xml
<Style Selector="#Save"><Setter Property="Foreground" Value="Red" /></Style>
<Style Selector="Button"><Setter Property="Foreground" Value="Green" /></Style>
```

What colour is `<Button Name="Save" Content="Save" />`?
- [ ] Red: an id selector is more specific than a type selector
- [x] Green: both match, they're in the same collection, and the later style wins
- [ ] Both are applied, so it blends into brown
- [ ] Default foreground: conflicting styles cancel each other out
> Avalonia doesn't rank selectors by specificity the way CSS does. Neither selector has a class or a
> pseudo-class, so both are plain styles in the same tier and the same collection, and the last one
> declared wins. If you want `#Save` to win, declare it after the general style (or move it closer to
> the control).
:::

:::quiz id=dsk-06-q8 xp=10
Same window, same order, but the first style now uses a class:

```xml
<Style Selector="Button.accent"><Setter Property="Foreground" Value="Red" /></Style>
<Style Selector="Button"><Setter Property="Foreground" Value="Green" /></Style>
```

What colour is `<Button Classes="accent" Content="Save" />`?
- [x] Red: a selector with a class is a style trigger, and triggers beat plain styles regardless of order
- [ ] Green: the later style always wins
- [ ] Red: `Button.accent` has higher CSS specificity
- [ ] Green: a type selector beats a class selector
> Classes can be added and removed at runtime, so `Button.accent` is a **style trigger** with a higher
> priority than the plain `Button` style. Order only decides between styles of the same tier. It's not
> CSS specificity: `#Save` (no class) would still lose to a later `Button`, as in the previous question.
:::

:::challenge id=dsk-06-c1 lang=ts xp=50
title: Which selector matches, and which setter wins?
Simulate Avalonia's selector engine on a tiny element model. An element has a `type`, optional
`name`, `classes`, `pseudo` (active pseudo-classes, written without the colon) and a `parent`.

1. `matchesSegment(segment, el)`: one segment such as `Button`, `.accent`, `Button.accent:pointerover`
   or `#Save`. Optional type first (an **exact** match), then any number of `.class`, `:pseudo` and `#name` parts.
   **All** parts must match.
2. `matches(selector, el)`: segments separated by whitespace (**descendant**: some ancestor matches)
   or by ` > ` (**child**: the direct parent matches). The **last** segment must match `el` itself.
3. `isTrigger(selector)`: `true` if the selector contains a `.class` or `:pseudo` part in **any**
   segment (so `StackPanel.list Button` is a trigger), `false` otherwise (`Button`, `#Save`,
   `StackPanel > Button`).
4. `winningValue(styles, el)`: `styles` is one `Styles` collection, a list of `{ selector, value }` in
   declaration order. Avalonia's rule, with no CSS specificity: if any **trigger** style matches `el`,
   return the `value` of the **last** matching trigger style; otherwise return the `value` of the
   **last** matching plain style; return `undefined` if nothing matches.

hint: Split a segment with the regex `/([.#:]?)([A-Za-z][\w-]*)/g`: an empty prefix means a type name.
hint: For `matches`, split on whitespace and treat a lone `>` token as "the next segment is a direct child".
hint: Work right to left: check `el` against the last segment, then move to the parent (child) or try every ancestor (descendant).
hint: `isTrigger` is one regex test: a `.` or `:` followed by a letter, anywhere in the selector. In `winningValue`, remember the last matching trigger value and the last matching plain value separately.

```ts starter
export type El = { type: string; name?: string; classes?: string[]; pseudo?: string[]; parent?: El }

export function matchesSegment(segment: string, el: El): boolean {
  return false
}

export function matches(selector: string, el: El): boolean {
  return false
}

export function isTrigger(selector: string): boolean {
  return false
}

export function winningValue(styles: { selector: string; value: string }[], el: El): string | undefined {
  return undefined
}
```

```ts solution
export type El = { type: string; name?: string; classes?: string[]; pseudo?: string[]; parent?: El }

export function matchesSegment(segment: string, el: El): boolean {
  const parts = [...segment.matchAll(/([.#:]?)([A-Za-z][\w-]*)/g)]
  if (parts.length === 0) return false
  return parts.every(([, prefix, word]) => {
    if (prefix === '') return el.type === word
    if (prefix === '.') return (el.classes ?? []).includes(word)
    if (prefix === ':') return (el.pseudo ?? []).includes(word)
    return el.name === word
  })
}

export function matches(selector: string, el: El): boolean {
  const segs: string[] = []
  const combs: string[] = [] // combs[i] = combinator between segs[i] and segs[i + 1]
  let pendingChild = false
  for (const tok of selector.trim().split(/\s+/)) {
    if (tok === '>') { pendingChild = true; continue }
    if (segs.length > 0) combs.push(pendingChild ? '>' : ' ')
    segs.push(tok)
    pendingChild = false
  }
  const check = (i: number, node: El | undefined): boolean => {
    if (!node || !matchesSegment(segs[i], node)) return false
    if (i === 0) return true
    if (combs[i - 1] === '>') return check(i - 1, node.parent)
    for (let a = node.parent; a; a = a.parent) if (check(i - 1, a)) return true
    return false
  }
  return segs.length > 0 && check(segs.length - 1, el)
}

export function isTrigger(selector: string): boolean {
  return /[.:][A-Za-z]/.test(selector)
}

export function winningValue(styles: { selector: string; value: string }[], el: El): string | undefined {
  let plain: string | undefined
  let trigger: string | undefined
  for (const s of styles) {
    if (!matches(s.selector, el)) continue
    if (isTrigger(s.selector)) trigger = s.value
    else plain = s.value
  }
  return trigger ?? plain
}
```

```ts tests
const win: El = { type: 'Window' }
const panel: El = { type: 'StackPanel', parent: win }
const card: El = { type: 'Border', classes: ['quest-card'], parent: panel }
const save: El = { type: 'Button', name: 'Save', classes: ['accent'], pseudo: ['pointerover'], parent: panel }
const inCard: El = { type: 'Button', parent: card }

test('type, class, name and pseudo-class segments', () => {
  expect(matchesSegment('Button', save)).toBe(true)
  expect(matchesSegment('.accent', save)).toBe(true)
  expect(matchesSegment('#Save', save)).toBe(true)
  expect(matchesSegment('Button.accent:pointerover', save)).toBe(true)
  expect(matchesSegment('Button:pressed', save)).toBe(false)
  expect(matchesSegment('Border', save)).toBe(false)
})
test('type match is exact', () => {
  expect(matchesSegment('Button', { type: 'ToggleButton' })).toBe(false)
})
test('every part must match', () => {
  expect(matchesSegment('Button.accent.big', save)).toBe(false)
})
test('child combinator needs the direct parent', () => {
  expect(matches('StackPanel > Button', save)).toBe(true)
  expect(matches('StackPanel > Button', inCard)).toBe(false)
  expect(matches('Border.quest-card > Button', inCard)).toBe(true)
})
test('descendant combinator searches all ancestors', () => {
  expect(matches('StackPanel Button', inCard)).toBe(true)
  expect(matches('Window Button', inCard)).toBe(true)
  expect(matches('Window StackPanel Border Button', inCard)).toBe(true)
  expect(matches('Border Button', save)).toBe(false)
})
test('last segment must match the element itself', () => {
  expect(matches('Window StackPanel', save)).toBe(false)
  expect(matches('Button', save)).toBe(true)
})
test('isTrigger: a class or pseudo-class anywhere', () => {
  expect(isTrigger('Button')).toBe(false)
  expect(isTrigger('#Save')).toBe(false)
  expect(isTrigger('StackPanel > Button')).toBe(false)
  expect(isTrigger('Button.accent')).toBe(true)
  expect(isTrigger('Button:pointerover')).toBe(true)
  expect(isTrigger('Border.quest-card Button')).toBe(true)
})
test('plain styles: later matching style wins, no specificity', () => {
  const styles = [
    { selector: '#Save', value: 'red' },
    { selector: 'Button', value: 'green' },
    { selector: 'Border Button', value: 'blue' },
  ]
  expect(winningValue(styles, save)).toBe('green')
  expect(winningValue(styles, inCard)).toBe('blue')
  expect(winningValue(styles, card)).toBeUndefined()
})
test('a matching trigger style beats later plain styles', () => {
  const styles = [
    { selector: 'Button.accent', value: 'red' },
    { selector: 'Button', value: 'green' },
    { selector: '#Save', value: 'gold' },
  ]
  expect(winningValue(styles, save)).toBe('red')
  expect(winningValue(styles, inCard)).toBe('green')
})
test('among trigger styles the later one wins', () => {
  const styles = [
    { selector: 'Button:pointerover', value: 'hover' },
    { selector: '.accent', value: 'accent' },
    { selector: 'Button', value: 'plain' },
    { selector: 'Button:pressed', value: 'pressed' },
  ]
  expect(winningValue(styles, save)).toBe('accent')
  expect(winningValue(styles, { ...save, pseudo: ['pointerover', 'pressed'] })).toBe('pressed')
})
```
:::

## Pseudo-classes: styling state without triggers

A **pseudo-class** is a state flag the control turns on and off by itself, written with a colon. You
never set it; you only select on it.

| Pseudo-class | On while… |
|---|---|
| `:pointerover` | the mouse is over the control |
| `:pressed` | a button is being pressed |
| `:focus` / `:focus-visible` | it has keyboard focus (`-visible`: focus came from the keyboard) |
| `:disabled` | `IsEnabled="False"` |
| `:checked` / `:unchecked` | a `CheckBox`, `ToggleButton` or `ToggleSwitch` is on / off |
| `:selected` | a `ListBoxItem` / `TabItem` is selected |
| `:error` | a binding on the control has a validation error |

```xml
<Style Selector="Border.quest-card:pointerover">
  <Setter Property="Background" Value="{DynamicResource Brush.CardHover}" />
</Style>
```

That works for a plain `Border`, because the `Border` *is* what gets painted. Try the same on a
`Button` and nothing seems to happen. Why? A `Button` is drawn by its **template**: the visual
parts it's built from. Fluent's Button template contains a `ContentPresenter` named
`PART_ContentPresenter`, and the **theme's own** `:pointerover` style sets the background on *that*
inner element, which covers yours. So you target it through the template:

```xml
<Style Selector="Button.accent:pointerover /template/ ContentPresenter#PART_ContentPresenter">
  <Setter Property="Background" Value="{DynamicResource Brush.CardHover}" />
</Style>
```

Read it as: *a Button with class `accent`, while hovered → look inside its template → the
`ContentPresenter` named `PART_ContentPresenter`*.

:::tip title="Find the parts with DevTools"
Run the app in a Debug build and press **F12** to open Avalonia's Developer Tools (set up in
**Your First Avalonia App**). The visual tree shows every template part's type and name, and the
styles view shows which setters applied and which were overridden. It's the browser inspector for XAML.
:::

:::warn title="Template part names are not a public API"
`PART_ContentPresenter` is the name used by Fluent's `Button` template in Avalonia 11.3 and 12.x, but part
names can differ between controls, themes (Fluent vs Simple) and major versions. Always confirm them in
Developer Tools or in the theme source (https://github.com/AvaloniaUI/Avalonia, folder
`src/Avalonia.Themes.Fluent/Controls`) instead of copying them from memory.
:::

:::quiz id=dsk-06-q4 xp=10
`<Style Selector="Button:pointerover"><Setter Property="Background" Value="Orange"/></Style>` has no
visible effect with the Fluent theme. What's the fix?
- [ ] Use `:hover` instead of `:pointerover`
- [ ] Change the setter value to `{DynamicResource Orange}`
- [x] Target the template part: `Button:pointerover /template/ ContentPresenter#PART_ContentPresenter`
- [ ] Add `IsHitTestVisible="True"` to the Button
> The Button's background is painted by its `ContentPresenter` template part, and Fluent's own
> hover style sets that part's background directly. Your setter does change the Button's
> `Background` property, but the template ignores it while hovered. Select the part with `/template/`.
> `:hover` is CSS, not Avalonia.
:::

## ControlTheme: a control's default look

A **ControlTheme** is the complete, default appearance of a control type: its template plus its
default property values and state styles. `FluentTheme` is a big collection of ControlThemes, one per
control. You write your own when you want a **variant** of a control (a pill-shaped button), or when
you build a custom control that needs a look.

```xml
<Application.Resources>
  <ControlTheme x:Key="PillButton" TargetType="Button"
                BasedOn="{StaticResource {x:Type Button}}">
    <Setter Property="CornerRadius" Value="999" />
    <Setter Property="Padding" Value="16,6" />
    <Style Selector="^:pressed">
      <Setter Property="RenderTransform" Value="scale(0.97)" />
    </Style>
  </ControlTheme>
</Application.Resources>

<Button Theme="{StaticResource PillButton}" Content="Start quest" />
```

- `TargetType="Button"`: which control it's for.
- `BasedOn="{StaticResource {x:Type Button}}"`: start from Fluent's Button theme (keyed by the type
  itself) and change only what's listed. Without it you'd have to supply a whole template.
- `^` inside a ControlTheme means "the control this theme is applied to", so `^:pressed` = "this
  button while pressed". It's like `&` in Sass or nested CSS.
- `Theme="{StaticResource PillButton}"`: opt in per control. A ControlTheme is a resource, so
  `StaticResource` is fine here.

**Style vs ControlTheme:** styles are layered *on top of* a theme and can match many types with
selectors. A control has exactly **one** ControlTheme at a time, and you swap it, you don't stack it.
Use classes and styles for small tweaks ("accent colour", "strikethrough when done") and a ControlTheme
for "this is a different kind of button".

:::quiz id=dsk-06-q5 xp=10
What does `^` mean in `<Style Selector="^:pressed">` inside a `ControlTheme`?
- [ ] Any parent of the control
- [x] The control the theme is applied to (like `&` in Sass)
- [ ] The theme's `BasedOn` theme
- [ ] Every control in the window
> Nested styles inside a `ControlTheme` (or inside another style) use `^` to refer to the element the
> outer rule matched. `^:pressed` = "this button while pressed"; `^ /template/ Border` = "the Border in
> its template".
:::

## Fluent theme and theme variants (light / dark)

`<FluentTheme />` in `App.axaml` is what gives every control its modern Windows 11-style look. (There's
also `<SimpleTheme />`, a minimal theme that's easier to read and customise.) Fluent has a compact mode
(`<FluentTheme DensityStyle="Compact" />`) and lets you set the accent colour per variant:

```xml
<FluentTheme>
  <FluentTheme.Palettes>
    <ColorPaletteResources x:Key="Light" Accent="#3559E0" />
    <ColorPaletteResources x:Key="Dark" Accent="#8EA6FF" />
  </FluentTheme.Palettes>
</FluentTheme>
```

A **ThemeVariant** is the light/dark mode. There are three built-in values:

- `ThemeVariant.Light` and `ThemeVariant.Dark`: forced.
- `ThemeVariant.Default`: **follow the operating system** (what the template puts in `App.axaml`).

You *request* a variant, and Avalonia tells you the *actual* one:

```csharp
Application.Current!.RequestedThemeVariant = ThemeVariant.Dark;   // ask for dark
var now = Application.Current.ActualThemeVariant;                  // Dark (or the OS choice for Default)
```

To make **your own** tokens switch with the theme, put them in **ThemeDictionaries**: one
dictionary per variant, with the same keys in each:

```xml
<Application.Resources>
  <ResourceDictionary>
    <ResourceDictionary.ThemeDictionaries>
      <ResourceDictionary x:Key="Light">
        <SolidColorBrush x:Key="Brush.Card" Color="#FFFFFF" />
      </ResourceDictionary>
      <ResourceDictionary x:Key="Dark">
        <SolidColorBrush x:Key="Brush.Card" Color="#1E2230" />
      </ResourceDictionary>
    </ResourceDictionary.ThemeDictionaries>
  </ResourceDictionary>
</Application.Resources>
```

Any `{DynamicResource Brush.Card}` now repaints when the variant changes. To force one area into a
variant (a dark sidebar in a light app, or a preview of both modes side by side), wrap it in a
`ThemeVariantScope`:

```xml
<ThemeVariantScope RequestedThemeVariant="Dark">
  <Border Background="{DynamicResource Brush.Card}"><TextBlock Text="Always dark" /></Border>
</ThemeVariantScope>
```

**MAUI equivalent.** MAUI doesn't have theme dictionaries; it uses `AppThemeBinding` per value, and
`UserAppTheme` to force a mode:

```xml
<Border BackgroundColor="{AppThemeBinding Light=#FFFFFF, Dark=#1E2230}" />
```

```csharp
Application.Current!.UserAppTheme = AppTheme.Dark;   // AppTheme.Unspecified = follow the OS
```

(Remember MAUI apps can't be built on Linux; try MAUI snippets on Windows or macOS.)

:::quiz id=dsk-06-q6 xp=10
QuestBoard should **follow the OS** light/dark setting by default. Which value do you set?
- [ ] `RequestedThemeVariant="Light"`, then read the OS setting in code
- [x] `RequestedThemeVariant="Default"`
- [ ] `ActualThemeVariant="System"`
- [ ] Nothing: theme dictionaries detect the OS automatically even when a variant is forced
> `Default` means "inherit": at the Application level that's the platform's choice. `ActualThemeVariant`
> is read-only (it reports the result), and a forced `Light`/`Dark` ignores the OS.
:::

:::quiz id=dsk-06-q7 xp=10
Select **all** the things that must be true for a custom brush to switch when the user toggles dark mode.
- [x] The brush key is defined in both the `Light` and the `Dark` theme dictionary, with different values
- [x] Controls reference it with `DynamicResource`
- [ ] The brush is declared with `x:Shared="False"`
- [x] The code changes `RequestedThemeVariant` on the Application (or a `ThemeVariantScope`) that contains the controls
- [ ] Every view calls `InvalidateVisual()` after the switch
> Theme switching is three pieces: per-variant values (theme dictionaries), live lookups
> (`DynamicResource`) and a variant change on a scope above the controls. Repainting is automatic.
> A key that lives only in the `Default` theme dictionary is found in both modes, but it has one value,
> so it can't *switch*. `x:Shared` and `InvalidateVisual()` are unrelated.
:::

## Design tokens in XAML

A **design token** is a named design decision: a colour, a spacing step, a radius, a font size.
Teams (and design tools like Figma) agree on the names, and code uses the names, never raw values.

Good token sets have two layers:

- **Primitive tokens**, the palette: `Color.Blue.600 = #3559E0`. These say *what* the value is.
- **Semantic tokens**, the meaning: `Brush.Accent`, `Brush.Surface`, `Brush.Text`, `Brush.Danger`. These say
  *what it's for*, and they are what views reference.

Dark mode only remaps the semantic layer (`Brush.Surface` → a dark primitive). Views never change.

```xml
<!-- Tokens that never change with the theme -->
<CornerRadius x:Key="Radius.Card">10</CornerRadius>
<Thickness x:Key="Space.Card">14,10</Thickness>
<x:Double x:Key="Font.Title">22</x:Double>
```

:::job title="What you'll see at work"
Expect a `Themes/` or `Styles/` folder with `Colors.axaml`, `Tokens.axaml` and `Controls.axaml`, all
merged in `App.axaml`, plus a PR rule like "no hex colours in views". Reviewers will flag
`Background="#FFF"` in a view the way a web team flags inline styles. When a designer hands you a
Figma file, your first job is usually to map its colour styles onto semantic token keys.
:::

## Icons and fonts

**Icons as vector paths.** Desktop apps usually ship icons as **path geometry** (the same idea as the
`d` attribute of an SVG `<path>`) so they stay sharp at any DPI and can be recoloured by a brush:

```xml
<StreamGeometry x:Key="Icon.Moon">M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z</StreamGeometry>

<PathIcon Data="{StaticResource Icon.Moon}" Width="16" Height="16"
          Foreground="{DynamicResource Brush.Accent}" />
```

`StreamGeometry` is a compact, read-only shape. `PathIcon` draws it filled with `Foreground`, so the
icon follows your theme automatically. You can copy path data from icon sets like Fluent UI System
Icons or Material Design Icons (check the licence).

**Fonts.** Avalonia ships Inter as a package (`Avalonia.Fonts.Inter`, enabled by `.WithInterFont()` in
`Program.cs`). For your own font, add the files under `Assets/Fonts/`, include them as
`AvaloniaResource`, and reference the **folder + family name**:

```xml
<FontFamily x:Key="Font.Brand">avares://QuestBoard/Assets/Fonts#Nunito</FontFamily>
<TextBlock FontFamily="{StaticResource Font.Brand}" Text="QuestBoard" />
```

The part after `#` is the family name stored *inside* the font file, not the file name.

:::pro title="How senior teams keep styling maintainable"
- **Semantic tokens only in views.** Primitive colours appear in exactly one file.
- **Classes over one-off ControlThemes.** A new ControlTheme is a new component in the design system
  and gets reviewed like one.
- **Test both variants.** A headless UI test (like the one in the lab) or a screenshot test catches
  "invisible text in dark mode" before users do.
- **Remember the user's choice.** Store Light/Dark/System in settings and apply it at startup, before
  the first window shows, so there's no flash of the wrong theme.
:::

:::challenge id=dsk-06-c2 lang=ts xp=50
title: Resolve a resource through the dictionary chain
Simulate how `{DynamicResource key}` finds its value. A `Dict` has optional `entries`, optional
`themes` (a dictionary per variant: `Light`, `Dark`, `Default`) and optional `merged` dictionaries.

1. `lookupInDict(dict, key, variant)` returns `{ found: true, value }` or `{ found: false }`, searching
   **in this order**: the dict's own `entries` → `themes[variant]` → `themes.Default` → the `merged`
   dictionaries from the **last to the first** (each searched with the same rules, recursively).
2. `findResource(key, chain, variant)`: `chain` is a list of scopes from the control outward (control,
   parents…, Application). Return `{ value, scope }` from the **first** scope that has the key, or
   `undefined` if none does.

Values can be falsy (`0`, `''`, `false`), so check whether the key *exists*, not whether the value is truthy.

hint: `Object.prototype.hasOwnProperty.call(obj, key)` (or `key in obj`) checks existence.
hint: Loop merged dictionaries with `for (let i = merged.length - 1; i >= 0; i--)`.

```ts starter
export type Bag = Record<string, unknown>
export type Dict = { entries?: Bag; themes?: { Light?: Bag; Dark?: Bag; Default?: Bag }; merged?: Dict[] }
export type Scope = { name: string; resources: Dict }
export type Variant = 'Light' | 'Dark'

export function lookupInDict(dict: Dict, key: string, variant: Variant): { found: boolean; value?: unknown } {
  const v = dict.entries?.[key]
  return v ? { found: true, value: v } : { found: false }
}

export function findResource(key: string, chain: Scope[], variant: Variant): { value: unknown; scope: string } | undefined {
  return undefined
}
```

```ts solution
export type Bag = Record<string, unknown>
export type Dict = { entries?: Bag; themes?: { Light?: Bag; Dark?: Bag; Default?: Bag }; merged?: Dict[] }
export type Scope = { name: string; resources: Dict }
export type Variant = 'Light' | 'Dark'

const has = (bag: Bag | undefined, key: string): bag is Bag =>
  !!bag && Object.prototype.hasOwnProperty.call(bag, key)

export function lookupInDict(dict: Dict, key: string, variant: Variant): { found: boolean; value?: unknown } {
  if (has(dict.entries, key)) return { found: true, value: dict.entries[key] }
  const themed = dict.themes?.[variant]
  if (has(themed, key)) return { found: true, value: themed[key] }
  const fallback = dict.themes?.Default
  if (has(fallback, key)) return { found: true, value: fallback[key] }
  const merged = dict.merged ?? []
  for (let i = merged.length - 1; i >= 0; i--) {
    const r = lookupInDict(merged[i], key, variant)
    if (r.found) return r
  }
  return { found: false }
}

export function findResource(key: string, chain: Scope[], variant: Variant): { value: unknown; scope: string } | undefined {
  for (const scope of chain) {
    const r = lookupInDict(scope.resources, key, variant)
    if (r.found) return { value: r.value, scope: scope.name }
  }
  return undefined
}
```

```ts tests
const app: Scope = {
  name: 'Application',
  resources: {
    entries: { 'Radius.Card': 10 },
    themes: {
      Light: { 'Brush.Card': '#FFFFFF', 'Brush.Text': '#1B1F2A' },
      Dark: { 'Brush.Card': '#1E2230' },
      Default: { 'Brush.Text': '#000000' },
    },
    merged: [
      { entries: { 'Brush.Danger': 'red-old', 'Font.Ui': 'Inter' } },
      { entries: { 'Brush.Danger': 'red-new' } },
    ],
  },
}
const panel: Scope = { name: 'StackPanel', resources: { entries: { 'Brush.Card': 'green', 'Space.Gap': 0 } } }
const button: Scope = { name: 'Button', resources: {} }

test('own entries are found', () => {
  expect(lookupInDict(app.resources, 'Radius.Card', 'Light')).toEqual({ found: true, value: 10 })
})
test('theme dictionary for the active variant', () => {
  expect(lookupInDict(app.resources, 'Brush.Card', 'Light').value).toBe('#FFFFFF')
  expect(lookupInDict(app.resources, 'Brush.Card', 'Dark').value).toBe('#1E2230')
})
test('Default theme dictionary is the fallback', () => {
  expect(lookupInDict(app.resources, 'Brush.Text', 'Dark').value).toBe('#000000')
  expect(lookupInDict(app.resources, 'Brush.Text', 'Light').value).toBe('#1B1F2A')
})
test('merged dictionaries: last one wins, earlier ones still searched', () => {
  expect(lookupInDict(app.resources, 'Brush.Danger', 'Light').value).toBe('red-new')
  expect(lookupInDict(app.resources, 'Font.Ui', 'Light').value).toBe('Inter')
})
test('missing key', () => {
  expect(lookupInDict(app.resources, 'Nope', 'Light')).toEqual({ found: false })
  expect(findResource('Nope', [button, panel, app], 'Light')).toBeUndefined()
})
test('nearest scope wins', () => {
  expect(findResource('Brush.Card', [button, panel, app], 'Dark')).toEqual({ value: 'green', scope: 'StackPanel' })
  expect(findResource('Brush.Card', [button, app], 'Dark')).toEqual({ value: '#1E2230', scope: 'Application' })
})
test('falsy values still count as found', () => {
  expect(findResource('Space.Gap', [button, panel, app], 'Light')).toEqual({ value: 0, scope: 'StackPanel' })
})
```
:::

## Lab: a dark-mode toggle for QuestBoard

:::lab id=dsk-06-lab1 xp=80
title: Dark mode for QuestBoard, with tokens, styles and a headless test
You'll build a small, self-contained QuestBoard with semantic tokens in Light/Dark theme dictionaries,
a style file with classes and a `:pointerover` state, an icon, and a `ToggleSwitch` that flips the theme
through the view model. A headless Avalonia test proves the switch really repaints. Works on Windows,
macOS and Linux with the .NET 10 SDK.

**1. Create the folders and solution**

```bash
mkdir QuestBoardThemes && cd QuestBoardThemes
mkdir -p QuestBoard/ViewModels QuestBoard/Views QuestBoard/Styles QuestBoard.Tests
dotnet new sln -n QuestBoard
```

:::info
Already have QuestBoard from earlier lessons (made with `dotnet new avalonia.mvvm`)? You can merge
these files into it instead. The packages below are pinned to Avalonia 12.1.5, like every QuestBoard
lab, so the lab builds exactly as written (verified with the .NET 10 SDK: build with 0 warnings,
`dotnet test` 3/3). On an older **Avalonia 11.3** project every file works unchanged with all Avalonia
versions set to `11.3.22`, with one swap in the test project: replace `xunit.v3` `3.2.2` with `xunit`
`2.9.3`, because the 11.x headless test package targets xUnit v2.
:::

**2. `QuestBoard/QuestBoard.csproj`**

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
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

**3. `QuestBoard/Program.cs`**

```csharp
using Avalonia;

namespace QuestBoard;

public static class Program
{
    [System.STAThread]
    public static void Main(string[] args) =>
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();
}
```

**4. `QuestBoard/App.axaml`**: the tokens. Theme-independent tokens sit in the dictionary itself;
colours go into one theme dictionary per variant, with identical keys.

```xml
<Application xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             x:Class="QuestBoard.App"
             RequestedThemeVariant="Light">

  <Application.Resources>
    <ResourceDictionary>
      <!-- Theme-independent tokens -->
      <CornerRadius x:Key="Radius.Card">10</CornerRadius>
      <Thickness x:Key="Space.Card">14,10</Thickness>
      <x:Double x:Key="Font.Title">22</x:Double>
      <FontFamily x:Key="Font.Ui">avares://Avalonia.Fonts.Inter/Assets#Inter</FontFamily>
      <StreamGeometry x:Key="Icon.Moon">M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z</StreamGeometry>

      <!-- Theme-dependent tokens: same keys, one dictionary per variant -->
      <ResourceDictionary.ThemeDictionaries>
        <ResourceDictionary x:Key="Light">
          <SolidColorBrush x:Key="Brush.Surface" Color="#F6F7FB" />
          <SolidColorBrush x:Key="Brush.Card" Color="#FFFFFF" />
          <SolidColorBrush x:Key="Brush.CardHover" Color="#E8ECF8" />
          <SolidColorBrush x:Key="Brush.Text" Color="#1B1F2A" />
          <SolidColorBrush x:Key="Brush.Accent" Color="#3559E0" />
        </ResourceDictionary>
        <ResourceDictionary x:Key="Dark">
          <SolidColorBrush x:Key="Brush.Surface" Color="#12141C" />
          <SolidColorBrush x:Key="Brush.Card" Color="#1E2230" />
          <SolidColorBrush x:Key="Brush.CardHover" Color="#2A3044" />
          <SolidColorBrush x:Key="Brush.Text" Color="#E8EAF2" />
          <SolidColorBrush x:Key="Brush.Accent" Color="#8EA6FF" />
        </ResourceDictionary>
      </ResourceDictionary.ThemeDictionaries>
    </ResourceDictionary>
  </Application.Resources>

  <Application.Styles>
    <FluentTheme />
    <StyleInclude Source="avares://QuestBoard/Styles/QuestStyles.axaml" />
  </Application.Styles>
</Application>
```

**5. `QuestBoard/App.axaml.cs`**

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
            desktop.MainWindow = new MainWindow { DataContext = new MainViewModel() };
        }
        base.OnFrameworkInitializationCompleted();
    }
}
```

**6. `QuestBoard/Styles/QuestStyles.axaml`**: every colour is a `DynamicResource`, every fixed size a
`StaticResource`.

```xml
<Styles xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">

  <Style Selector="Window">
    <Setter Property="Background" Value="{DynamicResource Brush.Surface}" />
    <Setter Property="FontFamily" Value="{StaticResource Font.Ui}" />
  </Style>

  <Style Selector="TextBlock">
    <Setter Property="Foreground" Value="{DynamicResource Brush.Text}" />
  </Style>

  <Style Selector="TextBlock.title">
    <Setter Property="FontSize" Value="{StaticResource Font.Title}" />
    <Setter Property="FontWeight" Value="SemiBold" />
  </Style>

  <Style Selector="Border.quest-card">
    <Setter Property="Background" Value="{DynamicResource Brush.Card}" />
    <Setter Property="CornerRadius" Value="{StaticResource Radius.Card}" />
    <Setter Property="Padding" Value="{StaticResource Space.Card}" />
    <Setter Property="Margin" Value="0,0,0,8" />
  </Style>

  <Style Selector="Border.quest-card:pointerover">
    <Setter Property="Background" Value="{DynamicResource Brush.CardHover}" />
  </Style>

  <Style Selector="Border.quest-card TextBlock.xp">
    <Setter Property="Foreground" Value="{DynamicResource Brush.Accent}" />
    <Setter Property="FontWeight" Value="Bold" />
  </Style>
</Styles>
```

**7. `QuestBoard/ViewModels/MainViewModel.cs`**: `[ObservableProperty]` generates `IsDarkMode` and a
`partial void OnIsDarkModeChanged` hook that runs after every change.

```csharp
using System.Collections.ObjectModel;
using Avalonia;
using Avalonia.Styling;
using CommunityToolkit.Mvvm.ComponentModel;

namespace QuestBoard.ViewModels;

public record Quest(string Title, int Xp);

public partial class MainViewModel : ObservableObject
{
    public ObservableCollection<Quest> Quests { get; } =
    [
        new("Write the README", 20),
        new("Fix the login bug", 50),
        new("Review Sam's PR", 30),
    ];

    [ObservableProperty]
    public partial bool IsDarkMode { get; set; }

    // Generated hook: runs every time IsDarkMode changes.
    partial void OnIsDarkModeChanged(bool value)
    {
        if (Application.Current is { } app)
        {
            app.RequestedThemeVariant = value ? ThemeVariant.Dark : ThemeVariant.Light;
        }
    }
}
```

**8. `QuestBoard/Views/MainWindow.axaml`**

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:QuestBoard.ViewModels"
        x:Class="QuestBoard.Views.MainWindow"
        x:DataType="vm:MainViewModel"
        Title="QuestBoard" Width="420" Height="360">

  <DockPanel Margin="16">
    <Grid DockPanel.Dock="Top" ColumnDefinitions="*,Auto,Auto" Margin="0,0,0,12">
      <TextBlock Classes="title" Text="QuestBoard" VerticalAlignment="Center" />
      <PathIcon Grid.Column="1" Data="{StaticResource Icon.Moon}"
                Foreground="{DynamicResource Brush.Accent}" Margin="0,0,8,0" />
      <ToggleSwitch Grid.Column="2" x:Name="DarkToggle"
                    OnContent="Dark" OffContent="Light"
                    IsChecked="{Binding IsDarkMode}" />
    </Grid>

    <ItemsControl ItemsSource="{Binding Quests}">
      <ItemsControl.ItemTemplate>
        <DataTemplate x:DataType="vm:Quest">
          <Border Classes="quest-card">
            <Grid ColumnDefinitions="*,Auto">
              <TextBlock Text="{Binding Title}" />
              <TextBlock Grid.Column="1" Classes="xp" Text="{Binding Xp, StringFormat='+{0} XP'}" />
            </Grid>
          </Border>
        </DataTemplate>
      </ItemsControl.ItemTemplate>
    </ItemsControl>
  </DockPanel>
</Window>
```

**9. `QuestBoard/Views/MainWindow.axaml.cs`**

```csharp
using Avalonia.Controls;

namespace QuestBoard.Views;

public partial class MainWindow : Window
{
    public MainWindow() => InitializeComponent();
}
```

**10. Run it**

```bash
dotnet sln add QuestBoard/QuestBoard.csproj
dotnet run --project QuestBoard
```

A 420×360 window opens on a light grey background with three white quest cards and blue `+20 XP`
labels. Hovering a card tints it. Flip the switch to **Dark**: background, cards, text and the moon
icon all repaint instantly. Close the window.

**11. The tests.** `Avalonia.Headless.XUnit` runs the real `App` without a screen, so you can assert on
what the user would see.

`QuestBoard.Tests/QuestBoard.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
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
</Project>
```

`QuestBoard.Tests/TestApp.cs`:

```csharp
using Avalonia;
using Avalonia.Headless;

[assembly: AvaloniaTestApplication(typeof(QuestBoard.Tests.TestAppBuilder))]

namespace QuestBoard.Tests;

public static class TestAppBuilder
{
    // Uses the real App (so App.axaml resources load) without opening a real window.
    // Skia + Inter so text can be measured exactly like in the real app.
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UseSkia()
            .WithInterFont()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false });
}
```

`QuestBoard.Tests/ThemeTests.cs`:

```csharp
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Media;
using Avalonia.Styling;
using QuestBoard.ViewModels;
using QuestBoard.Views;
using Xunit;

namespace QuestBoard.Tests;

public class ThemeTests
{
    private static Color SurfaceColor(Window w) => ((ISolidColorBrush)w.Background!).Color;

    [AvaloniaFact]
    public void Starts_in_light_mode()
    {
        Application.Current!.RequestedThemeVariant = ThemeVariant.Light;
        var window = new MainWindow { DataContext = new MainViewModel() };
        window.Show();

        Assert.Equal(ThemeVariant.Light, Application.Current.ActualThemeVariant);
        Assert.Equal(Color.Parse("#F6F7FB"), SurfaceColor(window));
    }

    [AvaloniaFact]
    public void Toggle_switches_to_dark_and_back()
    {
        Application.Current!.RequestedThemeVariant = ThemeVariant.Light;
        var vm = new MainViewModel();
        var window = new MainWindow { DataContext = vm };
        window.Show();

        var toggle = window.FindControl<ToggleSwitch>("DarkToggle")!;
        toggle.IsChecked = true;                       // what a click does

        Assert.True(vm.IsDarkMode);
        Assert.Equal(ThemeVariant.Dark, Application.Current.ActualThemeVariant);
        Assert.Equal(Color.Parse("#12141C"), SurfaceColor(window)); // DynamicResource re-resolved

        toggle.IsChecked = false;
        Assert.Equal(Color.Parse("#F6F7FB"), SurfaceColor(window));
    }

    [AvaloniaFact]
    public void Both_theme_dictionaries_define_every_brush()
    {
        string[] keys = ["Brush.Surface", "Brush.Card", "Brush.CardHover", "Brush.Text", "Brush.Accent"];
        foreach (var variant in new[] { ThemeVariant.Light, ThemeVariant.Dark })
            foreach (var key in keys)
                Assert.True(Application.Current!.TryGetResource(key, variant, out _), $"{key} missing for {variant}");
    }
}
```

```bash
dotnet sln add QuestBoard.Tests/QuestBoard.Tests.csproj
dotnet test
```

Expected (the end of the output):

```text
Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 468 ms - QuestBoard.Tests.dll (net10.0)
```

**12. Break it on purpose.** In `QuestStyles.axaml`, change the `Window` background setter to
`{StaticResource Brush.Surface}` and run `dotnet test` again. All three tests fail with
`KeyNotFoundException : Static resource 'Brush.Surface' not found.` Change it back to `DynamicResource`
and the tests pass again. Now you've seen the most common theming bug in action.

:::tip title="Stretch goals"
- Use a three-way choice (Light / Dark / System → `ThemeVariant.Default`) with a `ComboBox`.
- Add a `PillButton` ControlTheme and use it for a "New quest" button.
- Add `Classes.done="{Binding IsDone}"` to quest titles with a strikethrough style.
:::

- [ ] `dotnet run --project QuestBoard` opens the window, and the toggle switches every colour between light and dark
- [ ] Hovering a quest card changes its background in both themes
- [ ] `dotnet test` reports `Passed: 3`
- [ ] Switching the Window background to `StaticResource` makes the tests fail, and switching back fixes them
- [ ] No hex colour appears in `MainWindow.axaml`: views use only token keys
:::

## Flashcards

:::cards id=dsk-06-cards1 xp=15 title="Styles, themes & resources"
Q: What is a resource, and what is a ResourceDictionary?
A: A resource is a reusable object stored under an `x:Key` (brush, number, geometry, template…).
   A ResourceDictionary is the key → object map that holds them (`Resources` on elements and the Application).
Q: In what order does Avalonia look up a resource key?
A: Control → parents → Application → theme. Inside one dictionary: own entries → theme dictionary for the
   variant (then Default) → merged dictionaries, last to first. Nearest match wins.
Q: StaticResource vs DynamicResource?
A: Static: looked up once at load, fast, no updates. Dynamic: subscribes and updates when the resource
   changes (theme switch). Theme-dependent values must be Dynamic.
Q: In Avalonia, when two matching styles set the same property, which wins?
A: First, trigger styles (a class or pseudo-class anywhere in the selector) beat plain styles. Within a tier,
   the one closer to the control wins, then the one declared later. No CSS specificity.
   A local value on the element beats all styles.
Q: Why doesn't `Button:pointerover` → Background work with Fluent?
A: The template's `ContentPresenter#PART_ContentPresenter` paints the background and Fluent styles it
   directly. Target `Button:pointerover /template/ ContentPresenter#PART_ContentPresenter`.
Q: What is a ControlTheme? How do you apply one?
A: A control's complete default look (template + setters + nested `^` state styles). Define with `x:Key`
   and `TargetType`, usually `BasedOn="{StaticResource {x:Type Button}}"`, apply with `Theme="{StaticResource Key}"`.
Q: How do you switch to dark mode in code? Follow the OS?
A: `Application.Current.RequestedThemeVariant = ThemeVariant.Dark;`. `ThemeVariant.Default` follows the OS.
   MAUI: `Application.Current.UserAppTheme = AppTheme.Dark` / `AppTheme.Unspecified`.
Q: Primitive vs semantic design tokens?
A: Primitive = raw palette value (`Color.Blue.600`). Semantic = purpose (`Brush.Accent`, `Brush.Surface`).
   Views use semantic tokens; dark mode remaps them.
Q: WPF trigger → Avalonia equivalent?
A: Property triggers → pseudo-classes (`:pointerover`, `:checked`); DataTriggers → conditional classes
   (`Classes.done="{Binding IsDone}"`).
:::

## Recap

- **Resources** are named values (`x:Key`) in **ResourceDictionaries**; lookup goes from the control
  outward and the nearest match wins. Merged dictionaries split tokens into files (last one wins).
- **StaticResource** = one-time lookup; **DynamicResource** = live lookup. Anything theme-dependent must be dynamic.
- Avalonia **styles** use CSS-like **selectors** (`Type`, `.class`, `#name`, `>`, descendant,
  `/template/`). There's no specificity: trigger styles (with a class or pseudo-class) beat plain ones,
  then closer and later styles win. WPF/MAUI use `TargetType` + triggers / VisualStateManager instead.
- **Pseudo-classes** (`:pointerover`, `:pressed`, `:checked`…) style state; Fluent controls often need
  `/template/ ContentPresenter#PART_ContentPresenter`.
- A **ControlTheme** is a control's whole default look; derive with `BasedOn`, nest states with `^`, apply with `Theme=`.
- **ThemeVariant** Light/Dark/Default plus **ThemeDictionaries** give you dark mode; `ThemeVariantScope`
  forces a variant for one area. MAUI uses `AppThemeBinding` and `UserAppTheme`.
- Keep **semantic design tokens** in one place, use `PathIcon` + `StreamGeometry` for icons and
  `avares://…#Family` for fonts, and test both themes headlessly.
