---
id: fe-19
title: Accessible Modals & Dialogs
level: advanced
minutes: 70
xp: 200
summary: Build a modal that works for everyone — dialog roles and labelling, focus on open, focus trap, Escape, focus return, portals, native <dialog> and the WCAG 2.2 AA basics behind them.
---

A modal dialog looks trivial — a box over a dimmed page. It is one of the **most commonly broken**
components on the web. Open a random site's "Subscribe" popup, press Tab a few times, and watch focus
wander *behind* the overlay onto links you can't see. Press Escape: nothing. Close it: focus jumps to the
top of the page and a keyboard user has to start again. For a screen-reader user, the dialog may not
even be announced.

This lesson builds a dialog that gets all of it right, and explains the accessibility rules that every
other component in your kit will follow too.

### Four words you need first

- **Assistive technology (AT)** — software or hardware that sits between the user and your page: screen readers
  (NVDA, JAWS, VoiceOver, TalkBack, Orca), screen magnifiers, switch devices, voice control.
- **Accessibility tree** — a simplified copy of the DOM the browser builds for AT. Each node has a **role**
  ("button", "dialog"), a **name** ("Save") and a **state** ("expanded", "disabled"). ARIA attributes only change this
  tree — they never add behaviour. `role="button"` on a `<div>` does *not* make it focusable or clickable by keyboard.
- **Accessible name** — what AT announces for an element: the text of a button, the `<label>` of an input, or for a
  dialog the element referenced by `aria-labelledby`. "Edit profile, dialog" is name + role.
- **Focus** — the single element that receives keyboard input right now (`document.activeElement`). Keyboard users
  move it with Tab / Shift+Tab; screen-reader users also follow it. If your code doesn't manage it, users get lost.

## WCAG 2.2 AA in five minutes

**WCAG** (Web Content Accessibility Guidelines) is the standard laws reference, usually through other standards:
the EU's European Accessibility Act (applies since June 2025) via EN 301 549, currently WCAG 2.1 AA; in the US
the ADA Title II rule (2.1 AA) and Section 508 (2.0 AA). Because 2.2 is backward compatible, most teams and
contracts now target **WCAG 2.2 AA**. The criteria are grouped under four principles, **POUR**:

| Principle | Examples that matter for components |
|---|---|
| **Perceivable** | 1.1.1 text alternatives (`alt`), 1.4.1 don't use colour alone, 1.4.3 text contrast ≥ 4.5:1, 1.4.11 UI/focus-ring contrast ≥ 3:1 |
| **Operable** | 2.1.1 everything works by keyboard, **2.1.2 no keyboard trap** (you can always get out), 2.4.3 logical focus order, 2.4.7 visible focus, **2.4.11 focus not obscured** (new in 2.2), **2.5.8 target size ≥ 24×24 px** (new in 2.2) |
| **Understandable** | 3.3.1 errors identified in text, 3.3.2 labels or instructions, **3.3.7 redundant entry** and **3.3.8 accessible authentication** (new in 2.2) |
| **Robust** | 4.1.2 name, role, value — every control exposes what it is, what it's called and its state |

Notice the tension a modal creates: we *want* to keep focus inside it (otherwise users tab into the
invisible page), but 2.1.2 forbids trapping users. The resolution: a modal focus loop is fine **as long
as there's an obvious keyboard way out** — Escape and a Close button.

:::quiz id=fe-19-q1 xp=15
Which of these are **new** success criteria in WCAG 2.2 at level A/AA? (Select all that apply.)
- [x] 2.4.11 Focus Not Obscured — a focused element must not be completely hidden by sticky headers, cookie banners or overlays
- [x] 2.5.8 Target Size (Minimum) — pointer targets at least 24×24 CSS px (or enough spacing)
- [ ] 1.4.3 Contrast (Minimum) — 4.5:1 for normal text
- [x] 3.3.8 Accessible Authentication — no cognitive tests like "retype these characters" without an alternative
- [ ] 2.1.1 Keyboard
> Contrast and Keyboard have been there since WCAG 2.0. 2.2 (October 2023) added focus-not-obscured,
> target size, dragging alternatives, consistent help, redundant entry and accessible authentication — and
> removed 4.1.1 Parsing.
:::

## Anatomy of an accessible modal

```tsx
<div className="backdrop" onClick={onBackdropClick}>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="edit-title"
    aria-describedby="edit-desc"      // optional: a short description
    className="dialog"
  >
    <h2 id="edit-title">Edit profile</h2>
    <p id="edit-desc">Changes are visible to your team.</p>
    …
    <button onClick={onClose}>Close</button>
  </div>
</div>
```

| Requirement | Why |
|---|---|
| `role="dialog"` | Screen readers announce "dialog" when focus enters it, so the user knows the context changed. |
| `aria-modal="true"` | Tells assistive tech the rest of the page is unavailable, so a screen reader's *virtual cursor* (the arrow-key reading mode) shouldn't wander behind it. It is only a hint — it does **not** stop Tab or clicks; you still need focus management and `inert` (below). |
| `aria-labelledby` → the heading | The dialog's **accessible name**: "Edit profile, dialog". Prefer pointing at the visible heading over `aria-label="…"`, so sighted and AT users get the same words. A dialog without a name fails 4.1.2. |
| `role="alertdialog"` for confirmations | For urgent "Are you sure?" prompts; pair it with `aria-describedby` so the question is read out. |
| Escape closes | Universal expectation, and your 2.1.2 escape hatch. |
| A visible Close/Cancel button | Not everyone has (or knows about) Escape — touch screen users with a screen reader, for example. |
| Clicking the backdrop closes (usually) | Mouse convenience — but **not** for dialogs holding unsaved form data. |

### Escape: listen on the document

A `keydown` handler on the dialog element only fires when focus is *inside* the dialog. If focus is still on
the trigger (or on `body`), it never hears the key. Listen on `document` while the dialog is open, and
clean up when it closes:

```tsx
useEffect(() => {
  if (!open) return
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
  document.addEventListener('keydown', onKey)
  return () => document.removeEventListener('keydown', onKey)
}, [open, onClose])
```

Two details in that snippet matter. The **cleanup** removes the listener when the dialog closes or unmounts —
forget it and every Escape press after the dialog is gone still calls `onClose`, and each re-open adds another
listener. And `onClose` is a **dependency**: if the parent passes a new arrow function every render, the effect
re-subscribes each render. That's harmless here (cheap), but it's why libraries keep the latest callback in a ref.

Keep focus capture/restore in its **own** effect with `[open]` only. If it shared the Escape effect, every parent
re-render (which creates a new `onClose`) would run the cleanup and then the effect again, so focus would jump to
the trigger and back to the first field, on every keystroke in a parent-controlled input, for example.

:::quiz id=fe-19-q3 xp=10
Spot the bug. Users report that Escape "only works sometimes" in this modal:

```tsx
function Modal({ open, onClose, children }: ModalProps) {
  if (!open) return null
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="t"
         onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <h2 id="t">Settings</h2>
      {children}
    </div>
  )
}
```

- [ ] `onKeyDown` doesn't fire for the Escape key; you need `onKeyUp`
- [x] The handler only runs while focus is inside the dialog; nothing moves focus in on open, so Escape is ignored until the user has clicked or tabbed into it
- [ ] React synthetic events don't bubble from children, so pressing Escape in an input inside the dialog is ignored
- [ ] `e.key` is `"Esc"` in all modern browsers
> Keyboard events go to the focused element and bubble up from there. Focus is still on the trigger (outside the
> dialog), so the dialog's `onKeyDown` never sees the key, but once the user clicks an input inside, it suddenly works.
> That's the "sometimes". Either listen on `document` or (better, and you'll do it next) move focus into the dialog
> on open. `onKeyDown` fires for Escape, React events *do* bubble, and `"Esc"` was only used by old IE/Edge.
:::

:::challenge id=fe-19-c1 lang=tsx xp=60 preview=ProfileDemo
title: Dialog semantics, Escape and backdrop
Turn the plain `Modal` into a real dialog:

- When `open` is false, render nothing.
- The panel has `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at an `<h2>` containing `title`
  (use `useId()` for the id).
- A button named **Close** calls `onClose`.
- **Escape** anywhere on the page calls `onClose` while open (a `document` listener in an effect).
- Clicking the **backdrop** (`data-testid="backdrop"`) calls `onClose`; clicking *inside* the panel does not.

hint: In the backdrop's `onClick`, compare `e.target === e.currentTarget` — clicks inside the panel bubble up with a different `target`.
hint: The effect: `if (!open) return; const onKey = …; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey)`.

```tsx starter
import { useEffect, useId, useState } from 'react'

type ModalProps = { open: boolean; onClose: () => void; title: string; children: React.ReactNode }

export function Modal({ open, onClose, title, children }: ModalProps) {
  return (
    <div className="backdrop" data-testid="backdrop">
      <div className="dialog">
        <div className="dialog-title">{title}</div>
        {children}
      </div>
    </div>
  )
}

export function ProfileDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Edit profile</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit profile">
        <p>Your profile is visible to your team.</p>
      </Modal>
    </>
  )
}
```

```tsx solution
import { useEffect, useId, useState } from 'react'

type ModalProps = { open: boolean; onClose: () => void; title: string; children: React.ReactNode }

export function Modal({ open, onClose, title, children }: ModalProps) {
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="backdrop" data-testid="backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

export function ProfileDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Edit profile</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Edit profile">
        <p>Your profile is visible to your team.</p>
      </Modal>
    </>
  )
}
```

```tsx tests
test('renders nothing while closed', () => {
  render(<ProfileDemo />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByTestId('backdrop')).toBeNull()
})
test('open dialog has role, aria-modal and a name from its heading', async () => {
  render(<ProfileDemo />)
  await user.click(screen.getByRole('button', { name: 'Edit profile' }))
  const dialog = screen.getByRole('dialog', { name: 'Edit profile' })
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(screen.getByRole('heading', { name: 'Edit profile' }).tagName).toBe('H2')
})
test('Close button closes', async () => {
  render(<ProfileDemo />)
  await user.click(screen.getByRole('button', { name: 'Edit profile' }))
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
test('Escape closes even when focus is outside the dialog', async () => {
  render(<ProfileDemo />)
  await user.click(screen.getByRole('button', { name: 'Edit profile' }))
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
})
test('Escape listener is removed when closed', async () => {
  const onClose = fn()
  const { rerender } = render(<Modal open onClose={onClose} title="T">x</Modal>)
  rerender(<Modal open={false} onClose={onClose} title="T">x</Modal>)
  await user.keyboard('{Escape}')
  expect(onClose).not.toHaveBeenCalled()
})
test('backdrop click closes, inside click does not', async () => {
  const onClose = fn()
  render(<Modal open onClose={onClose} title="Settings"><p>Body text</p></Modal>)
  await user.click(screen.getByText('Body text'))
  expect(onClose).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('backdrop'))
  expect(onClose).toHaveBeenCalledTimes(1)
})
```
:::

## Focus management: in, around, and back

Keyboard and screen-reader users live where **focus** is. Three rules:

1. **On open, move focus into the dialog.** Usually to the first focusable element (or one you marked with
   `data-autofocus`; see the caveat below). For a dialog that is mostly text, focus the dialog container itself
   (`tabIndex={-1}`) so reading starts at the top. For a destructive confirmation, focus the **least destructive** button (Cancel).
2. **While open, keep focus inside** (a focus *loop*): Tab on the last element goes to the first, Shift+Tab on
   the first goes to the last.
3. **On close, return focus to the element that opened it.** Otherwise focus falls back to `<body>` and the
   user loses their place — a 2.4.3 Focus Order failure.

Rules 1 and 3 fit neatly into one effect: remember `document.activeElement` when opening, restore it in the
cleanup. The order matters. At the *start* of the effect, focus is still on the trigger the user just activated.
By the time the cleanup runs, the dialog's DOM has already been removed and focus has fallen back to `<body>`, so
reading `document.activeElement` *there* would "restore" focus to nowhere.

Caveat: don't combine this with `autoFocus` inside the dialog. React focuses `autoFocus` elements during commit,
*before* your effect runs, so `activeElement` would already be inside the dialog and focus would "return" into a
removed node. Let the effect do the initial focus instead (for example, query `[data-autofocus]` before falling
back to `FOCUSABLE`), or capture the trigger in the click handler that opens the dialog.

```tsx
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

useEffect(() => {
  if (!open) return
  const previouslyFocused = document.activeElement as HTMLElement | null
  const node = dialogRef.current!
  const first = node.querySelector<HTMLElement>(FOCUSABLE)
  ;(first ?? node).focus()
  return () => previouslyFocused?.focus()      // runs when open becomes false or on unmount
}, [open])
```

The `FOCUSABLE` selector is the usual approximation of "things Tab can reach". It skips disabled controls and
elements explicitly removed from the tab order with `tabindex="-1"`. (Real libraries also check visibility, since
a `display: none` button matches the selector but can't take focus.)

:::quiz id=fe-19-q4 xp=10
A teammate refactors the focus-return effect and now focus lands on `<body>` after closing. What did they change?

```tsx
useEffect(() => {
  if (!open) return
  dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
  return () => {
    const previous = document.activeElement as HTMLElement | null
    previous?.focus()
  }
}, [open])
```

- [ ] The cleanup should be `useLayoutEffect`; `useEffect` cleanups never run on close
- [x] `document.activeElement` is read in the cleanup, after focus has already moved into (and out of) the dialog, so it's no longer the trigger
- [ ] `focus()` can't be called inside a cleanup function
- [ ] The dependency array must be empty for the cleanup to run
> The trigger must be captured **before** focus moves, i.e. at the start of the effect. In the cleanup, the element
> that was focused is inside the dialog (or already `<body>` because the dialog unmounted), so "restoring" it does
> nothing useful. `useEffect` cleanups do run when `open` changes, and calling `focus()` there is fine. That's
> exactly what the correct version does.
:::

:::challenge id=fe-19-c2 lang=tsx xp=60 preview=InviteDemo
title: Focus on open, return focus on close
The modal below has correct semantics and Escape handling but no focus management. Add it:

- When it opens, focus the **first focusable element** inside the dialog. If there is none, focus the dialog
  itself (give it `tabIndex={-1}`).
- When it closes — by Escape, the Cancel button or any other way — focus returns to whatever was focused before it opened.

A `FOCUSABLE` selector string is provided in setup.

hint: You need a `ref` on the dialog `div`: `const dialogRef = useRef<HTMLDivElement>(null)`.
hint: Read `document.activeElement` at the start of the effect — that's the trigger, since focus hasn't moved yet.
hint: The effect's cleanup runs when `open` turns false: `return () => previous?.focus()`.

```tsx setup
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
```

```tsx starter
import { useEffect, useId, useRef, useState } from 'react'

type ModalProps = { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }

export function Modal({ open, onClose, title, children }: ModalProps) {
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function InviteDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button>Search</button>
      <button onClick={() => setOpen(true)}>Invite teammate</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Invite teammate">
        <label htmlFor="invite-email">Email</label>
        <input id="invite-email" type="email" />
        <button onClick={() => setOpen(false)}>Cancel</button>
      </Modal>
    </>
  )
}
```

```tsx solution
import { useEffect, useId, useRef, useState } from 'react'

type ModalProps = { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }

export function Modal({ open, onClose, title, children }: ModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const node = dialogRef.current
    if (node) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? node).focus()
    }
    return () => previous?.focus()
  }, [open])

  if (!open) return null
  return (
    <div className="backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function InviteDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button>Search</button>
      <button onClick={() => setOpen(true)}>Invite teammate</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Invite teammate">
        <label htmlFor="invite-email">Email</label>
        <input id="invite-email" type="email" />
        <button onClick={() => setOpen(false)}>Cancel</button>
      </Modal>
    </>
  )
}
```

```tsx tests
test('focus moves to the first focusable element on open', async () => {
  render(<InviteDemo />)
  await user.click(screen.getByRole('button', { name: 'Invite teammate' }))
  expect(screen.getByLabelText('Email')).toHaveFocus()
})
test('Escape returns focus to the trigger', async () => {
  render(<InviteDemo />)
  const trigger = screen.getByRole('button', { name: 'Invite teammate' })
  await user.click(trigger)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(trigger).toHaveFocus()
})
test('Cancel returns focus to the trigger', async () => {
  render(<InviteDemo />)
  const trigger = screen.getByRole('button', { name: 'Invite teammate' })
  await user.click(trigger)
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(trigger).toHaveFocus()
})
test('a dialog without focusable content focuses itself', async () => {
  function TextOnly() {
    const [open, setOpen] = React.useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Show terms</button>
        <Modal open={open} onClose={() => setOpen(false)} title="Terms"><p>Be nice.</p></Modal>
      </>
    )
  }
  render(<TextOnly />)
  await user.click(screen.getByRole('button', { name: 'Show terms' }))
  const dialog = screen.getByRole('dialog', { name: 'Terms' })
  expect(dialog).toHaveFocus()
  expect(dialog).toHaveAttribute('tabindex', '-1')
})
```
:::

## The focus trap (focus loop)

Without a trap, Tab from the last button in the dialog moves to the next focusable element in the
*document* — a link in the page behind the overlay. The user is now typing into something they can't see.

There are two complementary techniques:

**1. Intercept Tab at the edges.** On `keydown`, if focus is on the last focusable element and the key is
Tab (without Shift), prevent the default and focus the first. Mirror it for Shift+Tab on the first.

```tsx
function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'Tab') return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (items.length === 0) { e.preventDefault(); return }
  const first = items[0], last = items[items.length - 1]
  if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
}
```

**2. Make the background `inert`.** The HTML `inert` attribute (supported in all modern browsers, and a
proper boolean prop in React 19) removes a subtree from the tab order *and* the accessibility tree *and*
blocks clicks. Put the app content in one container and the dialog in a sibling (that's what portals are
for), then set `inert` on the app container while the dialog is open:

```tsx
<div id="app" inert={dialogOpen}>…page…</div>
<div id="dialogs">{dialogOpen && <Dialog …/>}</div>
```

`inert` is the more robust of the two (it also stops screen-reader virtual cursors and stray clicks);
libraries typically use both. One catch: the dialog must **not** live inside the inert container, or it becomes
inert too. That's another reason dialogs are rendered as a sibling of the app root.

:::quiz id=fe-19-q5 xp=10
While a modal is open, a developer puts `aria-hidden="true"` on the app container behind it instead of `inert`.
What still goes wrong?
- [x] Keyboard users can still Tab to (and activate) links and buttons behind the overlay, because `aria-hidden` doesn't affect focus or clicks
- [ ] Nothing. `aria-hidden` and `inert` are equivalent
- [ ] The screen reader still reads the page behind the dialog
- [ ] The dialog itself becomes hidden from screen readers
> `aria-hidden` only prunes the accessibility tree, so screen readers stop reading the background (the third option
> is what it *does* fix). Focusability and pointer events are untouched, so a keyboard user can tab onto a control
> that AT now says doesn't exist, which is worse than no hiding at all. `inert` removes the subtree from focus, clicks
> *and* the accessibility tree in one attribute. The dialog is only affected if it's inside the hidden container.
:::

:::challenge id=fe-19-c3 lang=tsx xp=60 preview=SettingsDemo
title: Trap Tab inside the dialog
This modal moves focus in on open and back on close. But pressing Tab on the last button escapes to the
**Help** button behind the dialog. Add a focus loop with an `onKeyDown` handler on the dialog:

- Tab on the **last** focusable element → focus the **first** (and prevent the default move).
- Shift+Tab on the **first** → focus the **last**.
- If the dialog has no focusable elements, Tab does nothing.

hint: `const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))`
hint: `if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }`

```tsx setup
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
```

```tsx starter
import { useEffect, useId, useRef, useState } from 'react'

type ModalProps = { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }

export function Modal({ open, onClose, title, children }: ModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const node = dialogRef.current
    if (node) ((node.querySelector<HTMLElement>(FOCUSABLE)) ?? node).focus()
    return () => previous?.focus()
  }, [open])

  if (!open) return null
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
      <h2 id={titleId}>{title}</h2>
      {children}
    </div>
  )
}

export function SettingsDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Settings">
        <label htmlFor="display-name">Display name</label>
        <input id="display-name" />
        <button onClick={() => setOpen(false)}>Cancel</button>
        <button onClick={() => setOpen(false)}>Save</button>
      </Modal>
      <button>Help</button>
    </>
  )
}
```

```tsx solution
import { useEffect, useId, useRef, useState } from 'react'

type ModalProps = { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }

export function Modal({ open, onClose, title, children }: ModalProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const node = dialogRef.current
    if (node) ((node.querySelector<HTMLElement>(FOCUSABLE)) ?? node).focus()
    return () => previous?.focus()
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (items.length === 0) { e.preventDefault(); return }
    const first = items[0]
    const last = items[items.length - 1]
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  }

  if (!open) return null
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef} onKeyDown={onKeyDown}>
      <h2 id={titleId}>{title}</h2>
      {children}
    </div>
  )
}

export function SettingsDemo() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Settings">
        <label htmlFor="display-name">Display name</label>
        <input id="display-name" />
        <button onClick={() => setOpen(false)}>Cancel</button>
        <button onClick={() => setOpen(false)}>Save</button>
      </Modal>
      <button>Help</button>
    </>
  )
}
```

```tsx tests
test('Tab moves through the dialog normally', async () => {
  render(<SettingsDemo />)
  await user.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(screen.getByLabelText('Display name')).toHaveFocus()
  await user.keyboard('{Tab}')
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  await user.keyboard('{Tab}')
  expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus()
})
test('Tab on the last element wraps to the first, never reaching the page behind', async () => {
  render(<SettingsDemo />)
  await user.click(screen.getByRole('button', { name: 'Open settings' }))
  await user.keyboard('{Tab}{Tab}{Tab}')
  expect(screen.getByRole('button', { name: 'Help' })).not.toHaveFocus()
  expect(screen.getByLabelText('Display name')).toHaveFocus()
  await user.keyboard('{Tab}{Tab}{Tab}{Tab}')
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
})
test('Escape still closes and restores focus', async () => {
  render(<SettingsDemo />)
  const trigger = screen.getByRole('button', { name: 'Open settings' })
  await user.click(trigger)
  await user.keyboard('{Tab}{Tab}{Tab}{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(trigger).toHaveFocus()
})
test('a dialog without focusable children keeps focus on itself', async () => {
  function Empty() {
    const [open, setOpen] = React.useState(false)
    return <><button onClick={() => setOpen(true)}>Info</button><Modal open={open} onClose={() => setOpen(false)} title="Info"><p>Read only</p></Modal><button>After</button></>
  }
  render(<Empty />)
  await user.click(screen.getByRole('button', { name: 'Info' }))
  await user.keyboard('{Tab}')
  expect(screen.getByRole('dialog', { name: 'Info' })).toHaveFocus()
})
```
:::

## Portals: escaping the CSS box

Rendering a dialog *inline* (where its trigger is) works for these exercises, but in a real layout it
breaks: a parent with `overflow: hidden` clips it, a parent with `transform` or `filter` creates a new
**containing block** so `position: fixed` stops being relative to the viewport, and a parent's
`z-index` **stacking context** can trap it beneath a sticky header no matter how big its own `z-index` is.

`createPortal` (from `react-dom`) renders children into a different DOM node — usually `document.body` —
while keeping them in the same place in the **React** tree:

```tsx
import { createPortal } from 'react-dom'

function Modal({ open, children }: ModalProps) {
  if (!open) return null
  return createPortal(
    <div className="backdrop"><div role="dialog" aria-modal="true">…{children}</div></div>,
    document.body,
  )
}
```

Because it's the same React tree:

- **Context works** — the dialog still reads your theme, auth and query client.
- **React events bubble through the React tree**, not the DOM tree. A click inside the portal triggers an
  `onClick` on the component that *rendered* the modal, even though in the DOM the dialog is a child of `<body>`.
  That surprises people: wrap the dialog in `onClick={e => e.stopPropagation()}` only if you really need to.

:::quiz id=fe-19-q2 xp=10
A `<Card onClick={openDetails}>` renders a "Delete" button that opens a confirmation modal via
`createPortal(…, document.body)`. Clicking **Cancel** in the modal also opens the card's details. Why?
- [ ] Portals copy event handlers onto `document.body`
- [x] React synthetic events bubble along the React component tree, so the click reaches `Card`'s `onClick` even though the DOM parent is `<body>`
- [ ] `document.body` has a global click listener
- [ ] It's a browser bug with `position: fixed`
> Portals change where the DOM nodes live, not where the component sits in the React tree. Events and context follow
> the React tree. Fix it by rendering the modal outside the card, or stopping propagation at the modal boundary.
:::

## The native `<dialog>` element

Modern browsers ship a dialog that does most of this lesson for you:

```tsx
function NativeDialog({ open, onClose, title, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current!
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={titleId} className="dialog">
      <h2 id={titleId}>{title}</h2>
      {children}
      <form method="dialog"><button>Close</button></form>   {/* closes without JS */}
    </dialog>
  )
}
```

`showModal()` gives you, for free:

- the **top layer** — above everything, no `z-index` or portal needed, no clipping by ancestors;
- the rest of the page becomes **inert** (no Tab, no clicks, hidden from screen readers);
- **Escape** fires `cancel` then `close`;
- focus moves into the dialog on open, and browsers restore focus to the opener on close;
- a styleable `::backdrop` pseudo-element; `closedby="any"` (newer browsers) adds light-dismiss on backdrop click.

What you still own: the accessible name (`aria-labelledby`), sync between your React `open` state and the
element (listen to `onClose`, because Escape closes it *without* asking React), scroll locking, and exit animations.
`show()` (non-modal) gives none of the inertness, and toggling the `open` *attribute* directly
(`<dialog open>`) is the same as `show()`: no top layer, no inert page, no Escape. Always call `showModal()` for a modal.

:::quiz id=fe-19-q6 xp=10
You use the `NativeDialog` above but forget the `onClose={onClose}` prop. The user opens the dialog, presses
**Escape**, then clicks the **Open** button again. What happens?
- [ ] The dialog reopens normally; `showModal()` is called on every click
- [x] Nothing visible: the browser closed the `<dialog>`, but React's `open` state is still `true`, so `setOpen(true)` changes nothing and the effect doesn't re-run
- [ ] The browser throws `InvalidStateError` because the dialog is already open
- [ ] Escape is ignored, because native dialogs only close via `<form method="dialog">`
> Escape closes a modal `<dialog>` natively and fires `cancel` then `close`. React state only learns about it if you
> listen to `onClose`. Without that, state and DOM disagree: React thinks it's open, so setting `true` again is a
> no-op and the effect with `[open]` never calls `showModal()` again. No error is thrown: the `!d.open` guard means
> `showModal()` is never called on a dialog that's already open.
:::

:::pro title="What production teams actually do"
Use native `<dialog>` for simple cases, or a battle-tested headless library (Radix `Dialog`, React Aria
`Modal`, Headless UI `Dialog`) for complex ones: nested dialogs, animations, scroll lock with scrollbar
compensation, iOS quirks. Either way the dialog component in your kit gets **Playwright + axe tests**
(later lesson) that check: name, `aria-modal`, initial focus, Escape, focus return. Those five assertions
catch nearly every regression.
:::

:::job title="Accessibility in code review"
On a real team, a reviewer will ask *"What happens when I press Tab? Escape? Where does focus go when it
closes?"* — before looking at the styling. Expect a `docs/accessibility.md` or a PR template checkbox like
"Keyboard-tested" and "Screen reader smoke-tested (NVDA / VoiceOver)".
:::

## Confirmation dialogs

Destructive actions ("Delete project") deserve an **alertdialog**: it interrupts, it's announced with its
description, and initial focus goes to the **safe** choice so an accidental Enter doesn't destroy data.

:::challenge id=fe-19-c4 lang=tsx xp=60 preview=DeleteProject
title: A safe confirmation dialog
Implement `ConfirmDialog({ open, title, description, confirmLabel = 'Delete', onConfirm, onCancel })`:

- Renders nothing when closed.
- `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby` → an `<h2>` with the title, `aria-describedby` → a `<p>` with the description.
- Two buttons: **Cancel** (calls `onCancel`) and the confirm button labelled `confirmLabel` (calls `onConfirm`).
- On open, focus goes to **Cancel** — the least destructive option.
- **Escape** calls `onCancel`.

`DeleteProject` is given and uses it.

hint: Two ids from one `useId()`: `` `${id}-title` `` and `` `${id}-desc` ``.
hint: A `cancelRef` plus `useEffect(() => { if (open) cancelRef.current?.focus() }, [open])`.

```tsx starter
import { useEffect, useId, useRef, useState } from 'react'

type ConfirmProps = {
  open: boolean; title: string; description: string; confirmLabel?: string
  onConfirm: () => void; onCancel: () => void
}

export function ConfirmDialog({ open, title, description, confirmLabel = 'Delete', onConfirm, onCancel }: ConfirmProps) {
  if (!open) return null
  return (
    <div className="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
      <button onClick={onConfirm}>{confirmLabel}</button>
    </div>
  )
}

export function DeleteProject() {
  const [asking, setAsking] = useState(false)
  const [deleted, setDeleted] = useState(false)
  if (deleted) return <p>Project deleted</p>
  return (
    <>
      <button onClick={() => setAsking(true)}>Delete project</button>
      <ConfirmDialog
        open={asking}
        title="Delete “Apollo”?"
        description="This permanently removes the project and its 312 tasks."
        onCancel={() => setAsking(false)}
        onConfirm={() => { setAsking(false); setDeleted(true) }}
      />
    </>
  )
}
```

```tsx solution
import { useEffect, useId, useRef, useState } from 'react'

type ConfirmProps = {
  open: boolean; title: string; description: string; confirmLabel?: string
  onConfirm: () => void; onCancel: () => void
}

export function ConfirmDialog({ open, title, description, confirmLabel = 'Delete', onConfirm, onCancel }: ConfirmProps) {
  const id = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`}>
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-desc`}>{description}</p>
      <button type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
      <button type="button" className="btn-danger" onClick={onConfirm}>{confirmLabel}</button>
    </div>
  )
}

export function DeleteProject() {
  const [asking, setAsking] = useState(false)
  const [deleted, setDeleted] = useState(false)
  if (deleted) return <p>Project deleted</p>
  return (
    <>
      <button onClick={() => setAsking(true)}>Delete project</button>
      <ConfirmDialog
        open={asking}
        title="Delete “Apollo”?"
        description="This permanently removes the project and its 312 tasks."
        onCancel={() => setAsking(false)}
        onConfirm={() => { setAsking(false); setDeleted(true) }}
      />
    </>
  )
}
```

```tsx tests
const props = () => ({ open: true, title: 'Delete file?', description: 'This cannot be undone.', onConfirm: fn(), onCancel: fn() })
test('alertdialog is named and described', () => {
  render(<ConfirmDialog {...props()} />)
  const d = screen.getByRole('alertdialog', { name: 'Delete file?' })
  expect(d).toHaveAttribute('aria-modal', 'true')
  const desc = document.getElementById(d.getAttribute('aria-describedby')!)
  expect(desc).toHaveTextContent('This cannot be undone.')
})
test('initial focus is on Cancel', () => {
  render(<ConfirmDialog {...props()} />)
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
})
test('buttons call their callbacks; custom confirm label', async () => {
  const p = props()
  render(<ConfirmDialog {...p} confirmLabel="Remove" />)
  await user.click(screen.getByRole('button', { name: 'Remove' }))
  expect(p.onConfirm).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(p.onCancel).toHaveBeenCalledTimes(1)
})
test('Escape cancels', async () => {
  const p = props()
  render(<ConfirmDialog {...p} />)
  await user.keyboard('{Escape}')
  expect(p.onCancel).toHaveBeenCalledTimes(1)
  expect(p.onConfirm).not.toHaveBeenCalled()
})
test('accidental Enter right after opening does not delete', async () => {
  render(<DeleteProject />)
  await user.click(screen.getByRole('button', { name: 'Delete project' }))
  await user.keyboard('{Enter}')
  expect(screen.queryByText('Project deleted')).toBeNull()
  expect(screen.queryByRole('alertdialog')).toBeNull()
})
test('confirming deletes', async () => {
  render(<DeleteProject />)
  await user.click(screen.getByRole('button', { name: 'Delete project' }))
  await user.click(screen.getByRole('button', { name: 'Delete' }))
  expect(screen.getByText('Project deleted')).toBeInTheDocument()
})
```
:::

## Be the reviewer: test a dialog

:::challenge id=fe-19-c5 lang=tsx mode=tests xp=60
title: Write the dialog's regression tests
Here's a correct `Modal` and a `Demo` that uses it. Write tests (render `<Demo />`) that would catch the
three bugs we've hidden in broken versions: one forgets `aria-modal`, one ignores Escape, and one doesn't
return focus to the **Open** button on close.

hint: Open with `await user.click(screen.getByRole('button', { name: 'Open' }))`, then query `getByRole('dialog', { name: 'Rename' })`.
hint: After `await user.keyboard('{Escape}')`, assert both that the dialog is gone and that the Open button `toHaveFocus()`.
hint: Close via the Done button too — a mutant might only break one path.

```tsx impl
function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }) {
  const id = React.useId()
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  React.useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input,button')?.focus()
    return () => prev?.focus()
  }, [open])
  if (!open) return null
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  )
}
function Demo() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Rename">
        <label htmlFor="nm">Name</label><input id="nm" />
        <button onClick={() => setOpen(false)}>Done</button>
      </Modal>
    </>
  )
}
```

```tsx mutant
function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }) {
  const id = React.useId()
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input,button')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus() }
  }, [open, onClose])
  if (!open) return null
  return (
    <div role="dialog" aria-labelledby={id} ref={ref}>
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  )
}
function Demo() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Rename">
        <label htmlFor="nm">Name</label><input id="nm" />
        <button onClick={() => setOpen(false)}>Done</button>
      </Modal>
    </>
  )
}
```

```tsx mutant
function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }) {
  const id = React.useId()
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input,button')?.focus()
    return () => { prev?.focus() }
  }, [open, onClose])
  if (!open) return null
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  )
}
function Demo() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Rename">
        <label htmlFor="nm">Name</label><input id="nm" />
        <button onClick={() => setOpen(false)}>Done</button>
      </Modal>
    </>
  )
}
```

```tsx mutant
function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children?: React.ReactNode }) {
  const id = React.useId()
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('input,button')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [open, onClose])
  if (!open) return null
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  )
}
function Demo() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Rename">
        <label htmlFor="nm">Name</label><input id="nm" />
        <button onClick={() => setOpen(false)}>Done</button>
      </Modal>
    </>
  )
}
```

```tsx starter
test('opens a dialog', async () => {
  render(<Demo />)
  await user.click(screen.getByRole('button', { name: 'Open' }))
  expect(screen.getByRole('dialog', { name: 'Rename' })).toBeInTheDocument()
})
```

```tsx solution
test('opens a named modal dialog', async () => {
  render(<Demo />)
  await user.click(screen.getByRole('button', { name: 'Open' }))
  expect(screen.getByRole('dialog', { name: 'Rename' })).toHaveAttribute('aria-modal', 'true')
  expect(screen.getByLabelText('Name')).toHaveFocus()
})
test('Escape closes and returns focus', async () => {
  render(<Demo />)
  const open = screen.getByRole('button', { name: 'Open' })
  await user.click(open)
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(open).toHaveFocus()
})
test('Done closes and returns focus', async () => {
  render(<Demo />)
  const open = screen.getByRole('button', { name: 'Open' })
  await user.click(open)
  await user.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(open).toHaveFocus()
})
```
:::

## Scroll lock and other details

- **Scroll lock:** while a modal is open, the page behind shouldn't scroll. `document.body.style.overflow = 'hidden'`
  in an effect (restore on cleanup); add `scrollbar-gutter: stable` on `html` so the layout doesn't jump when the
  scrollbar disappears.
- **Focus visible:** never `outline: none` without a replacement. Use `:focus-visible` so mouse users don't see
  rings but keyboard users always do (2.4.7), with ≥ 3:1 contrast (1.4.11).
- **Focus not obscured (2.4.11):** sticky headers and cookie banners must not completely cover the focused
  element — `scroll-padding-top: var(--header-height)` on `html` fixes most cases.
- **Target size (2.5.8):** the × close button needs at least a 24×24 px hit area.
- **Motion:** respect `@media (prefers-reduced-motion: reduce)` for open/close animations.

:::warn title="Common dialog mistakes (check your own code for these)"
- **No accessible name** — `role="dialog"` with no `aria-labelledby`/`aria-label`: AT says just "dialog".
- **Hard-coded ids** like `id="title"` — two dialogs on a page, or one rendered twice, collide. Use `useId()`.
- **Removing focus outlines inside the dialog** (for example `.dialog *:focus { outline: none }`): keyboard users
  lose track of focus. Hiding the outline only on the `tabIndex={-1}` container itself is acceptable.
- **Closing on backdrop click for a form** — one stray click loses the user's input. Ask first, or don't.
- **Nested dialogs** where one Escape closes *both* — only the topmost dialog should react (libraries keep a stack).
- **Using `aria-hidden` instead of `inert`** on the background — hidden from AT but still tabbable.
:::

:::lab id=fe-19-lab1 xp=60
title: Native dialog + a real screen reader
In your Vite + React project (or a fresh `npm create vite@latest dialog-lab -- --template react-ts`):

1. Create `src/ui/Dialog.tsx` using the native `<dialog>` + `showModal()` pattern from this lesson. Sync React state
   via the `onClose` event so Escape keeps state correct.
2. Give it `aria-labelledby`, a visible **Close** button, and style `::backdrop`:

```css
dialog::backdrop { background: rgb(0 0 0 / 0.5); }
dialog { border: none; border-radius: 12px; padding: 1.5rem; max-width: min(90vw, 32rem); }
```

3. Open it with a button, then test **with the keyboard only** (put the mouse away):
   - Tab and Shift+Tab move only between controls inside the dialog. After the last one, browsers may move focus
     to their own toolbar/address bar, which is allowed, but focus must never land on your page *behind* the dialog.
   - Escape closes it; pressing **Open** again reopens it (proves React state was synced).
   - After closing, the **Open** button has focus again (you'll see its focus ring).
4. Turn on a screen reader — **NVDA** (Windows, free), **VoiceOver** (macOS: `Cmd + F5`) or **Orca** (Linux:
   `Super + Alt + S`) — and open the dialog. Expect something like *"Edit profile, dialog"* followed by the focused
   control, e.g. *"Name, edit text"*. If you only hear "dialog", your `aria-labelledby` is wrong.
5. Install the **axe DevTools** browser extension and scan the page with the dialog open. A good result is
   **0 issues** under "Automatic issues". Typical findings to fix: *"ARIA dialog and alertdialog nodes should have
   an accessible name"*, *"Buttons must have discernible text"* (an icon-only × button without `aria-label`).

- [ ] Opening the dialog announces its name and "dialog" in a screen reader
- [ ] Tab never reaches the page behind the open dialog
- [ ] Escape closes it and the React `open` state is `false` afterwards (reopening works)
- [ ] Focus returns to the trigger button after closing
- [ ] axe DevTools reports no violations for the open dialog
:::

## Recap

- WCAG 2.2 AA (POUR) is the practical target; laws currently reference 2.1 AA, which 2.2 includes. New in 2.2: focus not obscured, 24 px targets, accessible auth.
- A modal needs `role="dialog"` (or `alertdialog`), `aria-modal="true"`, an accessible name via `aria-labelledby`,
  a Close button and **Escape** (listen on `document`).
- **Focus**: move it in on open (first focusable, the dialog itself, or Cancel for destructive confirms), **loop** Tab
  inside, and **restore** it to the opener on close. Make the background `inert`.
- **Portals** escape `overflow`/stacking contexts; React events and context still follow the React tree.
- Native **`<dialog>` + `showModal()`** gives top layer, inertness, Escape and focus handling for free; you still own
  labelling and state sync (`onClose`).
- `aria-hidden` hides from AT only; `inert` hides from AT **and** removes focus and clicks.
- Test dialogs through roles and focus: name, `aria-modal`, initial focus, Escape, focus return.

:::cards id=fe-19-cards1 xp=15 title="Accessible dialogs"
Q: The four minimum ARIA/keyboard requirements of a modal?
A: `role="dialog"`, `aria-modal="true"`, an accessible name (`aria-labelledby`), and Escape (plus a Close button) to dismiss.
Q: Where should focus go when a modal opens?
A: Into it: first focusable element (or a `data-autofocus` target the effect looks for); the dialog container for text-heavy dialogs; Cancel for destructive confirmations.
Q: Where should focus go when it closes?
A: Back to the element that opened it (remember `document.activeElement` on open).
Q: How does a focus trap avoid violating WCAG 2.1.2 No Keyboard Trap?
A: There is always a keyboard way out — Escape and a focusable Close/Cancel button.
Q: What does the `inert` attribute do?
A: Removes a subtree from tab order and the accessibility tree and blocks pointer events — ideal for the page behind a modal.
Q: Why use a portal for modals?
A: To escape ancestors' `overflow: hidden`, transforms and z-index stacking contexts; context and events still follow the React tree.
Q: What does `dialog.showModal()` give you for free?
A: Top-layer rendering, inert background, Escape to close, focus moved in (and restored on close), and `::backdrop`.
Q: Why capture `document.activeElement` at the start of the open effect, not in the cleanup?
A: At the start it's still the trigger; by cleanup time focus has moved into the dialog or fallen back to `<body>`.
Q: `aria-hidden="true"` vs `inert` on the page behind a modal?
A: `aria-hidden` only hides from assistive tech; elements stay focusable and clickable. `inert` removes focus, clicks and AT access.
Q: alertdialog vs dialog?
A: `alertdialog` is for urgent interruptions like "Delete?" confirmations; use `aria-describedby` so the question is read aloud.
:::
