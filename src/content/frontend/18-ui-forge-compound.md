---
id: fe-18
title: "Component Forge II: Compound Components"
level: advanced
minutes: 60
xp: 190
summary: Build Tabs and Accordion as compound components sharing state through context, support controlled and uncontrolled use, and add roving-tabindex keyboard navigation.
---

Primitives wrap one element. Real widgets — tabs, accordions, menus, selects, comboboxes — are made of
**several cooperating parts** that share state: which tab is selected, which panel is open, which option
is highlighted. How you expose those parts to the developer using your kit is one of the most important
API decisions in a design system.

## Two ways to build Tabs

**Option A — configuration props:**

```tsx
<Tabs
  items={[
    { id: 'general', label: 'General', content: <GeneralForm /> },
    { id: 'billing', label: 'Billing', content: <BillingForm />, disabled: !isAdmin },
  ]}
/>
```

It looks tidy until the first feature request: "put a badge in the Billing tab", "add a tooltip to one
tab", "render the panels in a different container", "add a button to the right of the tab list". Each
request adds a prop (`renderLabel`, `tabListClassName`, `panelWrapper`, `extraContent`…). This is the
**"apropcalypse"** — the component's API grows forever and still can't do what the next person needs.

**Option B — compound components:**

```tsx
<Tabs defaultValue="general">
  <TabList aria-label="Settings">
    <Tab value="general">General</Tab>
    <Tab value="billing">Billing <Badge tone="warning">Due</Badge></Tab>
  </TabList>
  <TabPanel value="general"><GeneralForm /></TabPanel>
  <TabPanel value="billing"><BillingForm /></TabPanel>
</Tabs>
```

Each part is a small component; the developer **composes** them like HTML (`<select>` + `<option>`
is the original compound component). Badges, tooltips, wrappers and extra buttons need **no new API** —
they're just JSX. This is the pattern behind Radix UI, React Aria Components, Headless UI, Ark UI and
shadcn/ui.

:::quiz id=fe-18-q1 xp=10
What is the main advantage of a compound-component API (`<Tabs><TabList><Tab/>…`) over a single
component with an `items` prop?
- [ ] It renders faster
- [x] Consumers can compose arbitrary markup between and inside the parts without the component needing new props
- [ ] It doesn't need any state
- [ ] It avoids using Context
> Compound components invert control over markup: the kit owns behaviour and accessibility, the consumer owns
> structure. Performance is about the same, and under the hood they almost always *use* Context.
:::

## How the parts talk: context

The parent (`Tabs`) owns the state and provides it; the children read it. The context is private to the
module — consumers never touch it:

```tsx
type TabsCtx = { value: string; setValue: (v: string) => void; baseId: string }
const TabsContext = createContext<TabsCtx | null>(null)

function useTabs() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('<Tab> and <TabPanel> must be used inside <Tabs>')
  return ctx
}

export function Tabs({ defaultValue, children }: { defaultValue: string; children: React.ReactNode }) {
  const [value, setValue] = useState(defaultValue)
  const baseId = useId()
  return <TabsContext value={{ value, setValue, baseId }}><div className="tabs">{children}</div></TabsContext>
}

export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  const tabs = useTabs()
  const selected = tabs.value === value
  return (
    <button role="tab" type="button" aria-selected={selected}
      id={`${tabs.baseId}-tab-${value}`} aria-controls={`${tabs.baseId}-panel-${value}`}
      onClick={() => tabs.setValue(value)}>
      {children}
    </button>
  )
}
```

Note the React 19 syntax: `<TabsContext value={…}>` renders the context directly as a provider. In
React 18 code you'll see `<TabsContext.Provider value={…}>`, which still works.

The `useTabs()` hook that **throws** is not decoration. Without it, a `<Tab>` rendered outside `<Tabs>` reads
`null` and crashes later with *"Cannot read properties of null (reading 'value')"* — far from the real cause.
The custom error tells the developer exactly what they did wrong.

Why context and not `React.Children.map` + `cloneElement` (the old way)? Cloning only reaches **direct**
children. The moment someone wraps a `<Tab>` in a `<Tooltip>` or a `<div>`, the injected props are lost.
Context reaches any depth, so the composition stays truly free.

One cost to know about: every component that calls `useContext(TabsContext)` re-renders when the context
**value** changes, and `{{ value, setValue, baseId }}` is a new object on every render of `Tabs`. For a handful of
tabs that's irrelevant. In big widgets (a 500-row listbox) teams wrap the value in `useMemo`, or let the
React Compiler memoise it automatically.

`useId()` gives each `Tabs` instance a unique prefix, so tab and panel ids never collide when two tab sets
are on one page — and `aria-controls` / `aria-labelledby` can link them.

## Controlled vs uncontrolled

Native inputs support two modes, and so must your widgets:

```tsx
<input defaultValue="hi" />                          // uncontrolled: the input owns the state
<input value={text} onChange={e => setText(e.target.value)} />  // controlled: the parent owns it
```

For your components the convention (used by Radix, React Aria, MUI…) is:

| Prop | Meaning |
|---|---|
| `value` | **Controlled.** If it's not `undefined`, the component *displays* it and never changes it on its own. |
| `defaultValue` | **Uncontrolled.** Initial value; afterwards the component owns the state. |
| `onValueChange(next)` | Called on every user-initiated change, in **both** modes. |

Uncontrolled is convenient ("just give me tabs"). Controlled is needed whenever the parent must **read or
drive** the state: syncing the selected tab to the URL (`?tab=billing`), opening an accordion item from a
"Show details" link, resetting a form, or blocking a change until unsaved work is saved.

The trick is one tiny hook, which every design system has in some form:

```ts
function useControllableState<T>({ value, defaultValue, onChange }: {
  value?: T; defaultValue: T; onChange?: (v: T) => void
}): [T, (v: T) => void] {
  const [internal, setInternal] = useState(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? value : internal
  const setValue = (next: T) => {
    if (!isControlled) setInternal(next)   // only own the state when uncontrolled
    onChange?.(next)                        // always tell the parent
  }
  return [current, setValue]
}
```

Walk through both modes:

- **Uncontrolled** (`value` is `undefined`): `current` comes from internal state; a click calls `setInternal`, the
  component re-renders with the new value, and `onChange` lets the parent *observe* it (for analytics, say).
- **Controlled** (`value="a"`): `current` is always the prop. A click only calls `onChange("b")`. If the parent
  then sets its state to `"b"` and re-renders, the component shows `"b"`; if the parent refuses (unsaved changes!),
  nothing changes. The parent is the single source of truth.

The common bug is calling `setInternal` in controlled mode too: then the component's internal copy and the
parent's state can disagree, and you get "it changes, then jumps back" glitches.

:::warn title="Don't switch modes"
A component must not flip between controlled and uncontrolled during its life (`value` going from `'a'`
to `undefined`). React warns about this for `<input>`: *"A component is changing a controlled input to be
uncontrolled"*. The usual cause is `value={data?.name}` while data is loading — use `value={data?.name ?? ''}`.
:::

:::challenge id=fe-18-c1 lang=tsx xp=50 preview=ToggleDemo
title: useControllableState + Toggle
Implement the `useControllableState` hook and use it in a `Toggle` (a pressed/unpressed button):

- `Toggle({ pressed, defaultPressed = false, onPressedChange, children })` renders `<button type="button" aria-pressed=…>`.
- Uncontrolled (no `pressed` prop): clicking flips its own state.
- Controlled (`pressed` given): clicking does **not** change what it shows — it only calls `onPressedChange(!current)`.
- `onPressedChange` is called with the next value in **both** modes.

hint: `const isControlled = value !== undefined` — and only call `setInternal` when it's false.
hint: In `Toggle`: `const [on, setOn] = useControllableState({ value: pressed, defaultValue: defaultPressed, onChange: onPressedChange })`.

```tsx starter
import { useState } from 'react'

export function useControllableState<T>({ value, defaultValue, onChange }: {
  value?: T; defaultValue: T; onChange?: (v: T) => void
}): [T, (v: T) => void] {
  const [internal, setInternal] = useState(defaultValue)
  return [internal, setInternal]
}

type ToggleProps = {
  pressed?: boolean
  defaultPressed?: boolean
  onPressedChange?: (pressed: boolean) => void
  children: React.ReactNode
}

export function Toggle({ pressed, defaultPressed = false, onPressedChange, children }: ToggleProps) {
  const [on, setOn] = useState(defaultPressed)
  return <button type="button" aria-pressed={on} onClick={() => setOn(!on)}>{children}</button>
}

export function ToggleDemo() {
  const [bold, setBold] = useState(false)
  return (
    <div>
      <Toggle>Italic (uncontrolled)</Toggle>
      <Toggle pressed={bold} onPressedChange={setBold}>Bold (controlled)</Toggle>
      <p>Bold is {bold ? 'on' : 'off'}</p>
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

export function useControllableState<T>({ value, defaultValue, onChange }: {
  value?: T; defaultValue: T; onChange?: (v: T) => void
}): [T, (v: T) => void] {
  const [internal, setInternal] = useState(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? (value as T) : internal
  const setValue = (next: T) => {
    if (!isControlled) setInternal(next)
    onChange?.(next)
  }
  return [current, setValue]
}

type ToggleProps = {
  pressed?: boolean
  defaultPressed?: boolean
  onPressedChange?: (pressed: boolean) => void
  children: React.ReactNode
}

export function Toggle({ pressed, defaultPressed = false, onPressedChange, children }: ToggleProps) {
  const [on, setOn] = useControllableState({ value: pressed, defaultValue: defaultPressed, onChange: onPressedChange })
  return <button type="button" aria-pressed={on} onClick={() => setOn(!on)}>{children}</button>
}

export function ToggleDemo() {
  const [bold, setBold] = useState(false)
  return (
    <div>
      <Toggle>Italic (uncontrolled)</Toggle>
      <Toggle pressed={bold} onPressedChange={setBold}>Bold (controlled)</Toggle>
      <p>Bold is {bold ? 'on' : 'off'}</p>
    </div>
  )
}
```

```tsx tests
test('uncontrolled: flips its own state and reports it', async () => {
  const spy = fn()
  render(<Toggle onPressedChange={spy}>Italic</Toggle>)
  const b = screen.getByRole('button', { name: 'Italic' })
  expect(b).toHaveAttribute('aria-pressed', 'false')
  await user.click(b)
  expect(b).toHaveAttribute('aria-pressed', 'true')
  expect(spy).toHaveBeenCalledWith(true)
})
test('uncontrolled: respects defaultPressed', () => {
  render(<Toggle defaultPressed>Mute</Toggle>)
  expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true')
})
test('controlled: does not change by itself, but asks the parent', async () => {
  const spy = fn()
  render(<Toggle pressed={false} onPressedChange={spy}>Bold</Toggle>)
  const b = screen.getByRole('button', { name: 'Bold' })
  await user.click(b)
  expect(b).toHaveAttribute('aria-pressed', 'false')
  expect(spy).toHaveBeenCalledWith(true)
})
test('controlled: follows the parent state', async () => {
  function Parent() {
    const [on, setOn] = React.useState(true)
    return <><Toggle pressed={on} onPressedChange={setOn}>Bold</Toggle><p>{on ? 'on' : 'off'}</p></>
  }
  render(<Parent />)
  const b = screen.getByRole('button', { name: 'Bold' })
  expect(b).toHaveAttribute('aria-pressed', 'true')
  await user.click(b)
  expect(b).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByText('off')).toBeInTheDocument()
})
```
:::

## The ARIA tabs pattern

The WAI-ARIA Authoring Practices Guide (APG) defines exactly how a tab widget must look to assistive tech.
Screen readers then announce *"Billing, tab, 2 of 3, selected"* — but only if the roles are right:

| Element | Role / attributes |
|---|---|
| Container of the tabs | `role="tablist"` + `aria-label` (or `aria-labelledby`) |
| Each tab | `role="tab"`, `aria-selected="true/false"`, `aria-controls="<panel id>"`, `id` |
| Each panel | `role="tabpanel"`, `aria-labelledby="<tab id>"`, `id`; inactive panels `hidden` |

Rendering inactive panels with `hidden` (instead of not rendering them) keeps the `aria-controls` target
present in the DOM and preserves the panels' state (half-filled forms!). If panels are expensive, render
them lazily on first activation and keep them afterwards.

Two more APG details worth knowing:

- If a panel contains **no focusable element** (just text), give it `tabIndex={0}` so a keyboard user can Tab
  from the tab list into the panel content.
- For a **vertical** tab list, set `aria-orientation="vertical"` and use Arrow Up / Down instead of Left / Right.

A common mistake is building tabs from `<a href="#billing">` links or `<div onClick>`s. Links are announced as
links (users expect navigation), and divs aren't focusable — neither gives the "tab, 2 of 3, selected"
experience.

:::challenge id=fe-18-c2 lang=tsx xp=70 preview=SettingsTabs
title: Compound Tabs (controlled + uncontrolled)
Build `Tabs`, `TabList`, `Tab` and `TabPanel`:

- `Tabs({ value, defaultValue, onValueChange, children })` — supports both modes (a `useControllableState` is provided in setup) and provides context.
- `TabList({ children, ...rest })` — `<div role="tablist">`, spreading rest (for `aria-label`).
- `Tab({ value, children })` — `<button role="tab" type="button">` with `aria-selected`, `id`, `aria-controls`; click selects it.
- `TabPanel({ value, children })` — `<div role="tabpanel">` with `id`, `aria-labelledby` pointing at its tab; `hidden` when not selected.

Use `useId()` in `Tabs` for an id prefix, e.g. tab id `` `${baseId}-tab-${value}` `` and panel id `` `${baseId}-panel-${value}` ``.

hint: Context value: `{ value: current, setValue, baseId }`. Each part calls a `useTabs()` hook that throws outside `<Tabs>`.
hint: `<div role="tabpanel" hidden={!selected} …>` — `hidden` removes it from the accessibility tree.
hint: The tabpanel's accessible name comes from `aria-labelledby={tabId}`.

```tsx setup
function useControllableState<T>({ value, defaultValue, onChange }: { value?: T; defaultValue: T; onChange?: (v: T) => void }): [T, (v: T) => void] {
  const [internal, setInternal] = React.useState(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? (value as T) : internal
  return [current, (next: T) => { if (!isControlled) setInternal(next); onChange?.(next) }]
}
```

```tsx starter
import { createContext, useContext, useId } from 'react'

type TabsProps = { value?: string; defaultValue?: string; onValueChange?: (v: string) => void; children: React.ReactNode }

export function Tabs({ children }: TabsProps) {
  return <div className="tabs">{children}</div>
}

export function TabList({ children, ...rest }: React.ComponentProps<'div'>) {
  return <div {...rest}>{children}</div>
}

export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  return <button type="button">{children}</button>
}

export function TabPanel({ value, children }: { value: string; children: React.ReactNode }) {
  return <div>{children}</div>
}

export function SettingsTabs() {
  return (
    <Tabs defaultValue="general">
      <TabList aria-label="Settings">
        <Tab value="general">General</Tab>
        <Tab value="billing">Billing</Tab>
        <Tab value="team">Team</Tab>
      </TabList>
      <TabPanel value="general">General settings</TabPanel>
      <TabPanel value="billing">Billing settings</TabPanel>
      <TabPanel value="team">Team settings</TabPanel>
    </Tabs>
  )
}
```

```tsx solution
import { createContext, useContext, useId } from 'react'

type TabsCtx = { value: string; setValue: (v: string) => void; baseId: string }
const TabsContext = createContext<TabsCtx | null>(null)

function useTabs() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('Tabs parts must be used inside <Tabs>')
  return ctx
}

type TabsProps = { value?: string; defaultValue?: string; onValueChange?: (v: string) => void; children: React.ReactNode }

export function Tabs({ value, defaultValue = '', onValueChange, children }: TabsProps) {
  const [current, setValue] = useControllableState({ value, defaultValue, onChange: onValueChange })
  const baseId = useId()
  return (
    <TabsContext value={{ value: current, setValue, baseId }}>
      <div className="tabs">{children}</div>
    </TabsContext>
  )
}

export function TabList({ children, ...rest }: React.ComponentProps<'div'>) {
  return <div role="tablist" {...rest}>{children}</div>
}

export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  const tabs = useTabs()
  const selected = tabs.value === value
  return (
    <button
      role="tab"
      type="button"
      id={`${tabs.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${tabs.baseId}-panel-${value}`}
      onClick={() => tabs.setValue(value)}
    >
      {children}
    </button>
  )
}

export function TabPanel({ value, children }: { value: string; children: React.ReactNode }) {
  const tabs = useTabs()
  const selected = tabs.value === value
  return (
    <div role="tabpanel" id={`${tabs.baseId}-panel-${value}`} aria-labelledby={`${tabs.baseId}-tab-${value}`} hidden={!selected}>
      {children}
    </div>
  )
}

export function SettingsTabs() {
  return (
    <Tabs defaultValue="general">
      <TabList aria-label="Settings">
        <Tab value="general">General</Tab>
        <Tab value="billing">Billing</Tab>
        <Tab value="team">Team</Tab>
      </TabList>
      <TabPanel value="general">General settings</TabPanel>
      <TabPanel value="billing">Billing settings</TabPanel>
      <TabPanel value="team">Team settings</TabPanel>
    </Tabs>
  )
}
```

```tsx tests
test('roles: tablist with label, tabs, one visible panel', () => {
  render(<SettingsTabs />)
  expect(screen.getByRole('tablist', { name: 'Settings' })).toBeInTheDocument()
  expect(screen.getAllByRole('tab')).toHaveLength(3)
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: 'Billing' })).toHaveAttribute('aria-selected', 'false')
})
test('panel is labelled by its tab and controlled by it', () => {
  render(<SettingsTabs />)
  const tab = screen.getByRole('tab', { name: 'General' })
  const panel = screen.getByRole('tabpanel', { name: 'General' })
  expect(panel).toHaveTextContent('General settings')
  expect(tab.getAttribute('aria-controls')).toBe(panel.id)
})
test('clicking a tab selects it and shows its panel', async () => {
  render(<SettingsTabs />)
  await user.click(screen.getByRole('tab', { name: 'Billing' }))
  expect(screen.getByRole('tab', { name: 'Billing' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'false')
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Billing settings')
})
test('two tab sets on one page do not share ids', () => {
  render(<><SettingsTabs /><SettingsTabs /></>)
  const ids = screen.getAllByRole('tab').map((t) => t.id)
  expect(new Set(ids).size).toBe(6)
})
test('controlled mode: parent drives the selection', async () => {
  function Controlled() {
    const [tab, setTab] = React.useState('a')
    return (
      <>
        <button onClick={() => setTab('b')}>Jump to B</button>
        <Tabs value={tab} onValueChange={setTab}>
          <TabList aria-label="Demo"><Tab value="a">A</Tab><Tab value="b">B</Tab></TabList>
          <TabPanel value="a">Panel A</TabPanel>
          <TabPanel value="b">Panel B</TabPanel>
        </Tabs>
        <p>Current: {tab}</p>
      </>
    )
  }
  render(<Controlled />)
  await user.click(screen.getByRole('button', { name: 'Jump to B' }))
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel B')
  await user.click(screen.getByRole('tab', { name: 'A' }))
  expect(screen.getByText('Current: a')).toBeInTheDocument()
})
test('a fully controlled tab set ignores clicks until the parent agrees', async () => {
  const spy = fn()
  render(
    <Tabs value="a" onValueChange={spy}>
      <TabList aria-label="Locked"><Tab value="a">A</Tab><Tab value="b">B</Tab></TabList>
      <TabPanel value="a">Panel A</TabPanel>
      <TabPanel value="b">Panel B</TabPanel>
    </Tabs>,
  )
  await user.click(screen.getByRole('tab', { name: 'B' }))
  expect(spy).toHaveBeenCalledWith('b')
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel A')
})
```
:::

## Keyboard: roving tabindex

A tab list with 8 tabs should **not** cost a keyboard user 8 Tab presses to get past it. The APG rule:

- **Tab** moves focus *into* the tab list (onto the selected tab) and then *out* of it to the panel.
- **Arrow Left / Right** move between tabs (wrapping around).
- **Home / End** jump to the first / last tab.

The technique is called **roving tabindex**: exactly one tab has `tabIndex={0}` (the selected one); all
others have `tabIndex={-1}` — focusable by script, skipped by Tab. Arrow keys move focus *and* the `0`.

```tsx
function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  const i = tabs.indexOf(document.activeElement as HTMLElement)
  if (i === -1) return
  const next =
    e.key === 'ArrowRight' ? (i + 1) % tabs.length :
    e.key === 'ArrowLeft'  ? (i - 1 + tabs.length) % tabs.length :
    e.key === 'Home' ? 0 :
    e.key === 'End'  ? tabs.length - 1 : -1
  if (next === -1) return
  e.preventDefault()           // stop the page from scrolling on Home/End
  tabs[next].focus()
  setValue(tabs[next].dataset.value!)   // "automatic activation"
}
```

Two activation styles exist:

- **Automatic** — moving focus also selects the tab. Best when panels render instantly.
- **Manual** — arrows only move focus; **Enter/Space** selects. Use it when showing a panel is expensive
  (a network request, a heavy chart), so arrowing past a tab doesn't trigger work.

The same roving-tabindex technique powers toolbars, radio groups, menus, listboxes, grids and tree views.

:::quiz id=fe-18-q2 xp=15
In a tab list using roving tabindex, which statements are true? (Select all that apply.)
- [x] Only the selected tab has `tabIndex={0}`; the others have `tabIndex={-1}`
- [x] Pressing Tab from the tab list moves focus out of it, toward the active panel
- [ ] Every tab must be reachable with the Tab key
- [x] Arrow keys move focus between tabs, wrapping at the ends
- [ ] `tabIndex={-1}` makes an element impossible to focus
> `tabIndex={-1}` removes the element from the Tab sequence but it can still be focused with `.focus()`. That's
> exactly what roving tabindex relies on: one Tab stop for the whole widget, arrows inside it.
:::

:::challenge id=fe-18-c3 lang=tsx xp=70 preview=KeyboardTabs
title: Arrow keys and roving tabindex
The tabs below work with the mouse. Add keyboard support with **automatic activation**:

- The selected tab has `tabIndex={0}`, every other tab `tabIndex={-1}`.
- On the tab list: **ArrowRight** / **ArrowLeft** move focus to the next / previous tab (wrapping) and select it;
  **Home** / **End** go to the first / last tab.
- Each tab already carries `data-value`, which you can read from the element.

hint: Put `onKeyDown` on `TabList`; keyboard events from a focused tab bubble up to it.
hint: `const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))` and find the index of `document.activeElement`.
hint: After `tabs[next].focus()`, call `setValue(tabs[next].dataset.value!)` from context.

```tsx starter
import { createContext, useContext, useState } from 'react'

type Ctx = { value: string; setValue: (v: string) => void }
const TabsContext = createContext<Ctx | null>(null)
const useTabs = () => useContext(TabsContext)!

export function Tabs({ defaultValue, children }: { defaultValue: string; children: React.ReactNode }) {
  const [value, setValue] = useState(defaultValue)
  return <TabsContext value={{ value, setValue }}>{children}</TabsContext>
}

export function TabList({ children, ...rest }: React.ComponentProps<'div'>) {
  return <div role="tablist" {...rest}>{children}</div>
}

export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  const tabs = useTabs()
  const selected = tabs.value === value
  return (
    <button role="tab" type="button" data-value={value} aria-selected={selected} onClick={() => tabs.setValue(value)}>
      {children}
    </button>
  )
}

export function TabPanel({ value, children }: { value: string; children: React.ReactNode }) {
  const tabs = useTabs()
  return <div role="tabpanel" hidden={tabs.value !== value}>{children}</div>
}

export function KeyboardTabs() {
  return (
    <Tabs defaultValue="one">
      <TabList aria-label="Steps">
        <Tab value="one">One</Tab>
        <Tab value="two">Two</Tab>
        <Tab value="three">Three</Tab>
      </TabList>
      <TabPanel value="one">Step one</TabPanel>
      <TabPanel value="two">Step two</TabPanel>
      <TabPanel value="three">Step three</TabPanel>
    </Tabs>
  )
}
```

```tsx solution
import { createContext, useContext, useState } from 'react'

type Ctx = { value: string; setValue: (v: string) => void }
const TabsContext = createContext<Ctx | null>(null)
const useTabs = () => useContext(TabsContext)!

export function Tabs({ defaultValue, children }: { defaultValue: string; children: React.ReactNode }) {
  const [value, setValue] = useState(defaultValue)
  return <TabsContext value={{ value, setValue }}>{children}</TabsContext>
}

export function TabList({ children, ...rest }: React.ComponentProps<'div'>) {
  const { setValue } = useTabs()
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
    const i = tabs.indexOf(document.activeElement as HTMLElement)
    if (i === -1) return
    const next =
      e.key === 'ArrowRight' ? (i + 1) % tabs.length :
      e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length :
      e.key === 'Home' ? 0 :
      e.key === 'End' ? tabs.length - 1 : -1
    if (next === -1) return
    e.preventDefault()
    tabs[next].focus()
    setValue(tabs[next].dataset.value!)
  }
  return <div role="tablist" onKeyDown={onKeyDown} {...rest}>{children}</div>
}

export function Tab({ value, children }: { value: string; children: React.ReactNode }) {
  const tabs = useTabs()
  const selected = tabs.value === value
  return (
    <button role="tab" type="button" data-value={value} aria-selected={selected} tabIndex={selected ? 0 : -1} onClick={() => tabs.setValue(value)}>
      {children}
    </button>
  )
}

export function TabPanel({ value, children }: { value: string; children: React.ReactNode }) {
  const tabs = useTabs()
  return <div role="tabpanel" hidden={tabs.value !== value}>{children}</div>
}

export function KeyboardTabs() {
  return (
    <Tabs defaultValue="one">
      <TabList aria-label="Steps">
        <Tab value="one">One</Tab>
        <Tab value="two">Two</Tab>
        <Tab value="three">Three</Tab>
      </TabList>
      <TabPanel value="one">Step one</TabPanel>
      <TabPanel value="two">Step two</TabPanel>
      <TabPanel value="three">Step three</TabPanel>
    </Tabs>
  )
}
```

```tsx tests
test('roving tabindex: only the selected tab is a Tab stop', () => {
  render(<KeyboardTabs />)
  expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('tabindex', '0')
  expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('tabindex', '-1')
  expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute('tabindex', '-1')
})
test('ArrowRight moves focus and selection', async () => {
  render(<KeyboardTabs />)
  await user.click(screen.getByRole('tab', { name: 'One' }))
  await user.keyboard('{ArrowRight}')
  const two = screen.getByRole('tab', { name: 'Two' })
  expect(two).toHaveFocus()
  expect(two).toHaveAttribute('aria-selected', 'true')
  expect(two).toHaveAttribute('tabindex', '0')
  expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('tabindex', '-1')
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Step two')
})
test('ArrowLeft wraps from first to last', async () => {
  render(<KeyboardTabs />)
  await user.click(screen.getByRole('tab', { name: 'One' }))
  await user.keyboard('{ArrowLeft}')
  expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus()
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Step three')
})
test('ArrowRight wraps from last to first', async () => {
  render(<KeyboardTabs />)
  await user.click(screen.getByRole('tab', { name: 'Three' }))
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus()
})
test('Home and End', async () => {
  render(<KeyboardTabs />)
  await user.click(screen.getByRole('tab', { name: 'Two' }))
  await user.keyboard('{End}')
  expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus()
  expect(screen.getByRole('tab', { name: 'Three' })).toHaveAttribute('aria-selected', 'true')
  await user.keyboard('{Home}')
  expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus()
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Step one')
})
```
:::

## Accordion: the same pattern, different ARIA

An accordion is a stack of headings, each with a button that shows/hides a section. Its ARIA is simpler
than tabs — no roving tabindex, every trigger is a normal Tab stop:

```tsx
<h3>
  <button aria-expanded={open} aria-controls={contentId} id={triggerId}>Shipping</button>
</h3>
<div role="region" id={contentId} aria-labelledby={triggerId} hidden={!open}>…</div>
```

- The **heading** wrapper keeps the document outline navigable (screen-reader users jump by heading).
- **`aria-expanded`** is what announces "collapsed / expanded". Toggling a CSS class alone says nothing.
- **`role="region"`** + label lets users jump to the open section. (APG suggests skipping `region` when
  you have more than ~6 panels, to avoid landmark noise.)

Accordions come in two flavours: **single** (opening one closes the others — like a FAQ) and **multiple**.
Structurally there are now *two* levels of context: the accordion (which values are open) and each item
(its own value and ids), so the trigger and content don't need to be told their value again.

Why `string[]` for the open state even in single mode? One shape for both modes keeps `toggle` and the
`includes()` checks identical; single mode simply never puts more than one value in the array.

:::info title="The native alternative"
HTML has a built-in disclosure widget: `<details><summary>Shipping</summary>…</details>`. It's keyboard-accessible
and announces expanded/collapsed with zero JavaScript, and giving several `<details>` the same `name` attribute
makes them exclusive (single mode), supported in all current browsers. For a simple FAQ it's often the best
choice. Teams still build the React version when they need controlled state, animation hooks, or consistent
styling and behaviour with the rest of the kit.
:::

:::challenge id=fe-18-c4 lang=tsx xp=70 preview=FaqAccordion
title: Compound Accordion (single & multiple)
Build an `Accordion` with four parts:

- `Accordion({ type = 'single', defaultValue = [], children })` — holds the array of open item values.
  `single`: opening an item closes the others. `multiple`: items open independently. Clicking an open item closes it.
- `AccordionItem({ value, children })` — provides an **item context** (`value`, `triggerId`, `contentId` via `useId`).
- `AccordionTrigger({ children })` — `<h3><button type="button" …></h3>` with `id`, `aria-expanded`, `aria-controls`.
- `AccordionContent({ children })` — `<div role="region">` with `id`, `aria-labelledby`, `hidden` when closed.

hint: Accordion context: `{ open: string[], toggle(value) }`. In `toggle`: if open → filter it out; else `type === 'single' ? [value] : [...open, value]`.
hint: Item context: `const id = useId(); { value, triggerId: id + '-trigger', contentId: id + '-content' }`.

```tsx starter
import { createContext, useContext, useId, useState } from 'react'

type AccordionProps = { type?: 'single' | 'multiple'; defaultValue?: string[]; children: React.ReactNode }

export function Accordion({ children }: AccordionProps) {
  return <div className="accordion">{children}</div>
}

export function AccordionItem({ value, children }: { value: string; children: React.ReactNode }) {
  return <div className="accordion-item">{children}</div>
}

export function AccordionTrigger({ children }: { children: React.ReactNode }) {
  return <h3><button type="button">{children}</button></h3>
}

export function AccordionContent({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>
}

export function FaqAccordion() {
  return (
    <Accordion type="single">
      <AccordionItem value="shipping">
        <AccordionTrigger>Shipping</AccordionTrigger>
        <AccordionContent>Ships in 2 days.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="returns">
        <AccordionTrigger>Returns</AccordionTrigger>
        <AccordionContent>30-day returns.</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
```

```tsx solution
import { createContext, useContext, useId, useState } from 'react'

type AccordionCtx = { open: string[]; toggle: (v: string) => void }
const AccordionContext = createContext<AccordionCtx | null>(null)
type ItemCtx = { value: string; triggerId: string; contentId: string }
const ItemContext = createContext<ItemCtx | null>(null)

function useAccordion() {
  const ctx = useContext(AccordionContext)
  if (!ctx) throw new Error('Accordion parts must be inside <Accordion>')
  return ctx
}
function useItem() {
  const ctx = useContext(ItemContext)
  if (!ctx) throw new Error('Trigger/Content must be inside <AccordionItem>')
  return ctx
}

type AccordionProps = { type?: 'single' | 'multiple'; defaultValue?: string[]; children: React.ReactNode }

export function Accordion({ type = 'single', defaultValue = [], children }: AccordionProps) {
  const [open, setOpen] = useState<string[]>(defaultValue)
  const toggle = (v: string) =>
    setOpen((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : type === 'single' ? [v] : [...cur, v]))
  return (
    <AccordionContext value={{ open, toggle }}>
      <div className="accordion">{children}</div>
    </AccordionContext>
  )
}

export function AccordionItem({ value, children }: { value: string; children: React.ReactNode }) {
  const id = useId()
  return (
    <ItemContext value={{ value, triggerId: id + '-trigger', contentId: id + '-content' }}>
      <div className="accordion-item">{children}</div>
    </ItemContext>
  )
}

export function AccordionTrigger({ children }: { children: React.ReactNode }) {
  const acc = useAccordion()
  const item = useItem()
  const expanded = acc.open.includes(item.value)
  return (
    <h3>
      <button type="button" id={item.triggerId} aria-expanded={expanded} aria-controls={item.contentId} onClick={() => acc.toggle(item.value)}>
        {children}
      </button>
    </h3>
  )
}

export function AccordionContent({ children }: { children: React.ReactNode }) {
  const acc = useAccordion()
  const item = useItem()
  return (
    <div role="region" id={item.contentId} aria-labelledby={item.triggerId} hidden={!acc.open.includes(item.value)}>
      {children}
    </div>
  )
}

export function FaqAccordion() {
  return (
    <Accordion type="single">
      <AccordionItem value="shipping">
        <AccordionTrigger>Shipping</AccordionTrigger>
        <AccordionContent>Ships in 2 days.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="returns">
        <AccordionTrigger>Returns</AccordionTrigger>
        <AccordionContent>30-day returns.</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
```

```tsx tests
function Multi() {
  return (
    <Accordion type="multiple" defaultValue={['a']}>
      <AccordionItem value="a"><AccordionTrigger>Alpha</AccordionTrigger><AccordionContent>Alpha body</AccordionContent></AccordionItem>
      <AccordionItem value="b"><AccordionTrigger>Beta</AccordionTrigger><AccordionContent>Beta body</AccordionContent></AccordionItem>
    </Accordion>
  )
}
test('starts collapsed with correct ARIA wiring', () => {
  render(<FaqAccordion />)
  const trigger = screen.getByRole('button', { name: 'Shipping' })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(trigger.closest('h3')).not.toBeNull()
  expect(screen.queryByRole('region')).toBeNull()
  const content = document.getElementById(trigger.getAttribute('aria-controls')!)
  expect(content).toHaveTextContent('Ships in 2 days.')
  expect(content).toHaveAttribute('aria-labelledby', trigger.id)
})
test('clicking opens and closes an item', async () => {
  render(<FaqAccordion />)
  const trigger = screen.getByRole('button', { name: 'Shipping' })
  await user.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('region', { name: 'Shipping' })).toHaveTextContent('Ships in 2 days.')
  await user.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('region')).toBeNull()
})
test('single: opening one closes the other', async () => {
  render(<FaqAccordion />)
  await user.click(screen.getByRole('button', { name: 'Shipping' }))
  await user.click(screen.getByRole('button', { name: 'Returns' }))
  expect(screen.getByRole('button', { name: 'Shipping' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getAllByRole('region')).toHaveLength(1)
  expect(screen.getByRole('region', { name: 'Returns' })).toBeInTheDocument()
})
test('multiple: defaultValue and independent items', async () => {
  render(<Multi />)
  expect(screen.getByRole('region', { name: 'Alpha' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Beta' }))
  expect(screen.getAllByRole('region')).toHaveLength(2)
})
```
:::

:::job title="Build or buy?"
Most teams don't hand-roll tabs, menus and comboboxes for production any more. They use a **headless**
library — Radix UI, React Aria Components, Headless UI, Ark UI — which ships the behaviour and ARIA, and
style it with their own tokens (that's exactly what shadcn/ui is: Radix + Tailwind, copied into your repo).
You still need everything in this lesson: to evaluate those libraries, to wrap them in your kit's API, to
debug them, and to build the one widget they don't have.
:::

:::pro title="Test behaviour through roles"
Notice that every test in this lesson queries `getByRole('tab', { name })`, `aria-selected`,
`aria-expanded` — never class names. Tests written against the accessibility tree survive restyling *and*
double as accessibility checks: if the test can't find "Billing, tab", neither can a screen reader.
:::

:::quiz id=fe-18-q3 xp=10
A teammate's `<Tabs value={selectedTab}>` sometimes receives `undefined` while data loads, then a string.
What's the problem?
- [x] The component switches from uncontrolled to controlled mid-life, so its internal state and the prop disagree
- [ ] Nothing — `undefined` is a valid tab value
- [ ] Tabs can't be controlled
- [ ] It causes a memory leak
> With the `value !== undefined` convention, `undefined` means "uncontrolled". While data loads, the component
> runs on its own internal state (the user may even click another tab), and when the string arrives it suddenly
> jumps to the prop — the same bug React warns about for `<input>`; libraries like Radix log a similar dev warning.
> "`undefined` is a valid value" is exactly the misunderstanding: in this API it means "not controlled". It isn't
> a leak either. Pass a real value (`value={selectedTab ?? 'general'}`) or don't render the tabs until data is there.
:::

:::quiz id=fe-18-q4 xp=15
Spot the bug. Clicking a tab does nothing at all — no error, the first tab just stays selected:

```tsx
const [tab, setTab] = useState('general')

<Tabs value={tab}>
  <TabList aria-label="Settings">
    <Tab value="general">General</Tab>
    <Tab value="billing">Billing</Tab>
  </TabList>
  …
</Tabs>
```

- [ ] `useState` can't hold the selected tab; use `useRef`
- [x] It's controlled (`value` is set) but no `onValueChange` updates `tab`, so the component asks for a change nobody performs
- [ ] `Tabs` needs `defaultValue` as well as `value`
- [ ] The tab values must be numbers, not strings
> A controlled component never changes what it displays on its own; it calls `onValueChange` and waits for the
> parent. Add `onValueChange={setTab}`. Passing `defaultValue` too doesn't help: when `value` is defined,
> `defaultValue` is ignored. A ref wouldn't even trigger a re-render, and string values are perfectly fine.
:::

:::quiz id=fe-18-q5 xp=15
An old `Tabs` passes `selected` and `onSelect` to each tab with `React.Children.map(children, c => cloneElement(c, …))`.
A teammate wraps one tab: `<Tooltip content="Admins only"><Tab value="billing">Billing</Tab></Tooltip>`.
What happens?
- [ ] It works — `cloneElement` passes props down to every descendant
- [x] The props are injected into `Tooltip` instead of `Tab`, so the Billing tab never knows whether it's selected
- [ ] React throws because `Tooltip` isn't a `Tab`
- [ ] Only the styling breaks; selection still works through the DOM
> `Children.map` only sees **direct** children, so the clone adds `selected`/`onSelect` to the `Tooltip` element,
> which ignores them. Nothing throws — the tab just silently stops working, which is why this is a nasty bug.
> Context-based parts read state from the nearest provider at any depth, so wrapping them is safe.
:::

## Recap

- **Compound components** split a widget into parts that the consumer composes; the kit owns behaviour + ARIA,
  the consumer owns markup. They avoid the endless prop growth of config-object APIs.
- Parts share state through a **private context** (with a throwing hook); `useId()` makes ids unique per instance.
- Support **controlled** (`value` + `onValueChange`) and **uncontrolled** (`defaultValue`) modes with a
  `useControllableState` hook; never switch modes during a component's life.
- **Tabs**: `tablist` / `tab` (`aria-selected`, `aria-controls`) / `tabpanel` (`aria-labelledby`, `hidden`).
- **Roving tabindex**: one Tab stop per widget (`tabIndex` 0 vs −1), arrows/Home/End inside; automatic vs manual activation.
- **Accordion**: heading + button with `aria-expanded`/`aria-controls`, `region` content; single vs multiple.
  For simple cases, native `<details name="…">` does the job with no JavaScript.

:::cards id=fe-18-cards1 xp=15 title="Compound components"
Q: What is a compound component?
A: A widget split into cooperating parts (`<Tabs><TabList><Tab/></TabList><TabPanel/></Tabs>`) that share implicit state, usually via context.
Q: Why context instead of `cloneElement` to pass state to parts?
A: `cloneElement` only reaches direct children; wrapping a part in any other element breaks it. Context reaches any depth.
Q: Controlled vs uncontrolled props convention?
A: `value` (controlled, parent owns state), `defaultValue` (uncontrolled, component owns it), `onValueChange` called in both modes.
Q: What is roving tabindex?
A: Only one item in a composite widget has `tabIndex=0`; the rest `-1`. Tab enters/leaves the widget, arrow keys move inside.
Q: Automatic vs manual tab activation?
A: Automatic: arrow focus also selects. Manual: arrows move focus, Enter/Space selects — for expensive panels.
Q: Which attribute announces an accordion section's open state?
A: `aria-expanded` on the trigger button (plus `aria-controls` pointing at the content).
Q: Why render inactive tab panels with `hidden` rather than not at all?
A: The `aria-controls` target stays in the DOM and panel state (e.g. a half-filled form) is preserved.
Q: In controlled mode, what happens when the user clicks a tab?
A: The component only calls `onValueChange(next)`. It shows the new tab only once the parent updates `value`.
:::
