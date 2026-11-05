// A small React Testing Library–like kit. Works in a browser iframe and in jsdom (validator).

/* eslint-disable @typescript-eslint/no-explicit-any */
type Matcher = string | RegExp

export interface DomKit {
  render: (el: unknown) => { container: HTMLElement; unmount: () => void; rerender: (el: unknown) => void }
  screen: Record<string, (...a: any[]) => any>
  user: Record<string, (...a: any[]) => Promise<void>>
  fireEvent: Record<string, (el: Element, init?: any) => void>
  waitFor: (f: () => unknown, opts?: { timeout?: number }) => Promise<unknown>
  act: (f: () => unknown) => Promise<unknown>
  cleanup: () => void
}

const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
const matches = (text: string, m: Matcher) => (typeof m === 'string' ? norm(text) === norm(m) : m.test(text))

function implicitRole(el: Element): string | null {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit.split(' ')[0]
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') || 'text').toLowerCase()
  switch (tag) {
    case 'button': return 'button'
    case 'a': return el.hasAttribute('href') ? 'link' : null
    case 'input':
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      if (type === 'search') return 'searchbox'
      if (type === 'hidden') return null
      return 'textbox'
    case 'textarea': return 'textbox'
    case 'select': return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    case 'option': return 'option'
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading'
    case 'ul': case 'ol': return 'list'
    case 'li': return 'listitem'
    case 'nav': return 'navigation'
    case 'main': return 'main'
    case 'header': return 'banner'
    case 'footer': return 'contentinfo'
    case 'aside': return 'complementary'
    case 'form': return 'form'
    case 'dialog': return 'dialog'
    case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img'
    case 'table': return 'table'
    case 'tr': return 'row'
    case 'td': return 'cell'
    case 'th': return 'columnheader'
    case 'progress': return 'progressbar'
    case 'article': return 'article'
    case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null
    default: return null
  }
}

function accessibleName(el: Element): string {
  const doc = el.ownerDocument
  const lb = el.getAttribute('aria-labelledby')
  if (lb) return norm(lb.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' '))
  const al = el.getAttribute('aria-label')
  if (al) return norm(al)
  const tag = el.tagName.toLowerCase()
  if (['input', 'textarea', 'select'].includes(tag)) {
    const id = el.getAttribute('id')
    if (id) { const l = doc.querySelector(`label[for="${CSS.escape ? CSS.escape(id) : id}"]`); if (l) return norm(l.textContent) }
    const wrap = el.closest('label')
    if (wrap) return norm(wrap.textContent)
    const t = (el as HTMLInputElement).type
    if (['button', 'submit', 'reset'].includes(t)) return norm((el as HTMLInputElement).value)
    return norm(el.getAttribute('title') || el.getAttribute('placeholder'))
  }
  if (tag === 'img') return norm(el.getAttribute('alt') || el.getAttribute('title'))
  return norm(el.textContent || el.getAttribute('title'))
}

function isHidden(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return true
    if (n.tagName === 'DIALOG' && !n.hasAttribute('open')) return true
    const st = (n as HTMLElement).style
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return true
  }
  return false
}

export function createDomKit(React: any, ReactDOMClient: any, doc: Document): DomKit {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const act: (f: () => unknown) => Promise<unknown> = async (f) => {
    let out: unknown
    await React.act(async () => { out = await f() })
    return out
  }
  const mounted: { root: any; container: HTMLElement }[] = []

  const cleanup = () => {
    for (const m of mounted.splice(0)) {
      try { React.act(() => m.root.unmount()) } catch { /* ignore */ }
      m.container.remove()
    }
    doc.body.innerHTML = ''
    for (const a of ['class', 'style', 'data-theme', 'dir']) doc.documentElement.removeAttribute(a)
  }

  const render = (el: unknown) => {
    const container = doc.createElement('div')
    doc.body.appendChild(container)
    const root = ReactDOMClient.createRoot(container)
    React.act(() => root.render(el))
    mounted.push({ root, container })
    return {
      container,
      unmount: () => React.act(() => root.unmount()),
      rerender: (next: unknown) => React.act(() => root.render(next)),
    }
  }

  const all = () => Array.from(doc.body.querySelectorAll('*'))

  const byText = (m: Matcher) => all().filter((el) => {
    if (['script', 'style'].includes(el.tagName.toLowerCase())) return false
    // own text: the element's text, but only if no child element also matches (deepest match)
    const txt = el.textContent || ''
    if (!matches(txt, m)) return false
    return !Array.from(el.children).some((c) => matches(c.textContent || '', m))
  })
  const byRole = (role: string, opts: { name?: Matcher; hidden?: boolean } = {}) => all().filter((el) =>
    implicitRole(el) === role && (opts.hidden || !isHidden(el)) && (opts.name === undefined || matches(accessibleName(el), opts.name)))
  const byLabel = (m: Matcher) => {
    const out: Element[] = []
    for (const l of Array.from(doc.querySelectorAll('label'))) {
      if (!matches(l.textContent || '', m)) continue
      const f = l.getAttribute('for')
      const target = f ? doc.getElementById(f) : l.querySelector('input,textarea,select')
      if (target) out.push(target)
    }
    for (const el of Array.from(doc.querySelectorAll('[aria-label]'))) if (matches(el.getAttribute('aria-label') || '', m)) out.push(el)
    for (const el of Array.from(doc.querySelectorAll('[aria-labelledby]'))) if (matches(accessibleName(el), m)) out.push(el)
    return [...new Set(out)]
  }
  const byPlaceholder = (m: Matcher) => all().filter((el) => el.hasAttribute('placeholder') && matches(el.getAttribute('placeholder') || '', m))
  const byTestId = (id: string) => Array.from(doc.querySelectorAll(`[data-testid="${id}"]`))

  const describeQ = (kind: string, args: unknown[]) => `${kind}(${args.map((a) => (a instanceof RegExp ? String(a) : JSON.stringify(a))).join(', ')})`
  const snapshot = () => {
    const h = doc.body.innerHTML
    return h.length > 1200 ? h.slice(0, 1200) + '…' : h
  }
  const roles = () => [...new Set(all().map((e) => implicitRole(e)).filter(Boolean))].join(', ')

  function family(name: string, finder: (...a: any[]) => Element[]) {
    const get = (...a: any[]) => {
      const r = finder(...a)
      if (r.length === 0) throw new Error(`Unable to find element: ${describeQ(name, a)}${name === 'ByRole' ? `\nRoles on page: ${roles()}` : ''}\n\nDOM:\n${snapshot()}`)
      if (r.length > 1) throw new Error(`Found ${r.length} elements for ${describeQ(name, a)} — use getAll${name}`)
      return r[0]
    }
    const getAll = (...a: any[]) => {
      const r = finder(...a)
      if (!r.length) throw new Error(`Unable to find elements: ${describeQ(name, a)}\n\nDOM:\n${snapshot()}`)
      return r
    }
    const query = (...a: any[]) => { const r = finder(...a); if (r.length > 1) throw new Error(`Found ${r.length} elements for ${describeQ(name, a)}`); return r[0] ?? null }
    const queryAll = (...a: any[]) => finder(...a)
    const find = (...a: any[]) => waitFor(() => get(...a))
    const findAll = (...a: any[]) => waitFor(() => getAll(...a))
    return { [`get${name}`]: get, [`getAll${name}`]: getAll, [`query${name}`]: query, [`queryAll${name}`]: queryAll, [`find${name}`]: find, [`findAll${name}`]: findAll }
  }

  const waitFor = async (f: () => unknown, opts: { timeout?: number } = {}) => {
    const end = Date.now() + (opts.timeout ?? 1500)
    let last: unknown
    for (;;) {
      try { let v: unknown; await act(async () => { v = await f() }); return v } catch (e) { last = e }
      if (Date.now() > end) throw last
      await act(() => new Promise((r) => setTimeout(r, 20)))
    }
  }

  const screen = {
    ...family('ByText', byText),
    ...family('ByRole', byRole),
    ...family('ByLabelText', byLabel),
    ...family('ByPlaceholderText', byPlaceholder),
    ...family('ByTestId', byTestId),
    debug: () => console.log(snapshot()),
  }

  const win = doc.defaultView as any
  const dispatch = (el: Element, ev: Event) => { React.act(() => { el.dispatchEvent(ev) }) }
  const mouse = (type: string) => (el: Element, init: any = {}) => dispatch(el, new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
  const fireEvent: DomKit['fireEvent'] = {
    click: mouse('click'), mouseDown: mouse('mousedown'), mouseUp: mouse('mouseup'), mouseEnter: mouse('mouseover'), mouseOver: mouse('mouseover'),
    focus: (el) => React.act(() => (el as HTMLElement).focus()),
    blur: (el) => React.act(() => (el as HTMLElement).blur()),
    keyDown: (el, init) => dispatch(el, new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })),
    keyUp: (el, init) => dispatch(el, new win.KeyboardEvent('keyup', { bubbles: true, cancelable: true, ...init })),
    submit: (el) => dispatch(el, new win.Event('submit', { bubbles: true, cancelable: true })),
    change: (el, init) => {
      if (init?.target?.value !== undefined) setValue(el as HTMLInputElement, init.target.value)
      if (init?.target?.checked !== undefined) (el as HTMLInputElement).checked = init.target.checked
      dispatch(el, new win.Event('input', { bubbles: true }))
      dispatch(el, new win.Event('change', { bubbles: true }))
    },
    input: (el, init) => {
      if (init?.target?.value !== undefined) setValue(el as HTMLInputElement, init.target.value)
      dispatch(el, new win.Event('input', { bubbles: true }))
    },
  }

  function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) {
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, v)
    else (el as HTMLInputElement).value = v
  }

  const KEYS: Record<string, string> = { 'Shift+Tab': 'ShiftTab', Enter: 'Enter', Escape: 'Escape', Esc: 'Escape', Tab: 'Tab', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', Backspace: 'Backspace', Space: ' ' }

  const pressKey = (key: string) => {
    const target = (doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc.body) as HTMLElement
    const shift = key === 'ShiftTab'
    const down = new win.KeyboardEvent('keydown', { key: shift ? 'Tab' : key, shiftKey: shift, bubbles: true, cancelable: true })
    dispatch(target, down)
    if (!down.defaultPrevented) {
      if (key === 'Enter') {
        if (target.tagName === 'BUTTON' || (target.tagName === 'A' && target.hasAttribute('href'))) dispatch(target, new win.MouseEvent('click', { bubbles: true, cancelable: true }))
        else if (target.tagName === 'INPUT' && (target as HTMLInputElement).form) {
          const form = (target as HTMLInputElement).form!
          dispatch(form, new win.Event('submit', { bubbles: true, cancelable: true }))
        }
      } else if (key === ' ' && (target.tagName === 'BUTTON' || (target as HTMLInputElement).type === 'checkbox')) {
        dispatch(target, new win.MouseEvent('click', { bubbles: true, cancelable: true }))
      } else if (key === 'Tab' || key === 'ShiftTab') {
        const focusables = Array.from(doc.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]'))
          .filter((e) => !isHidden(e) && e.getAttribute('tabindex') !== '-1')
        const i = focusables.indexOf(target)
        const n = focusables.length
        const next = key === 'Tab' ? focusables[(i + 1) % Math.max(1, n)] : focusables[i <= 0 ? n - 1 : i - 1]
        if (next) React.act(() => next.focus())
      }
    }
    dispatch(target, new win.KeyboardEvent('keyup', { key: shift ? 'Tab' : key, shiftKey: shift, bubbles: true, cancelable: true }))
  }

  const user: DomKit['user'] = {
    click: async (el: Element) => {
      if (!el) throw new Error('user.click: element is null')
      if ((el as HTMLButtonElement).disabled) return
      fireEvent.mouseDown(el)
      if ((el as HTMLElement).focus) React.act(() => (el as HTMLElement).focus())
      fireEvent.mouseUp(el)
      fireEvent.click(el)
      await act(() => Promise.resolve())
    },
    type: async (el: Element, text: string) => {
      if (!el) throw new Error('user.type: element is null')
      const input = el as HTMLInputElement
      React.act(() => input.focus())
      const parts = text.match(/\{[^}]+\}|[\s\S]/g) || []
      for (const p of parts) {
        if (p.startsWith('{') && p.length > 2) { pressKey(KEYS[p.slice(1, -1)] || p.slice(1, -1)); continue }
        dispatch(input, new win.KeyboardEvent('keydown', { key: p, bubbles: true }))
        setValue(input, (input.value ?? '') + p)
        dispatch(input, new win.Event('input', { bubbles: true }))
        dispatch(input, new win.KeyboardEvent('keyup', { key: p, bubbles: true }))
      }
      await act(() => Promise.resolve())
    },
    clear: async (el: Element) => {
      const input = el as HTMLInputElement
      React.act(() => input.focus())
      setValue(input, '')
      dispatch(input, new win.Event('input', { bubbles: true }))
      await act(() => Promise.resolve())
    },
    selectOptions: async (el: Element, value: string) => {
      setValue(el as HTMLSelectElement, value)
      dispatch(el, new win.Event('change', { bubbles: true }))
      await act(() => Promise.resolve())
    },
    keyboard: async (seq: string) => {
      const parts = seq.match(/\{[^}]+\}|[\s\S]/g) || []
      for (const p of parts) {
        if (p.startsWith('{') && p.length > 2) pressKey(KEYS[p.slice(1, -1)] || p.slice(1, -1))
        else {
          const t = doc.activeElement as HTMLInputElement
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
            setValue(t, (t.value ?? '') + p)
            dispatch(t, new win.Event('input', { bubbles: true }))
          } else pressKey(p)
        }
      }
      await act(() => Promise.resolve())
    },
    tab: async (opts?: { shift?: boolean }) => { pressKey(opts?.shift ? 'ShiftTab' : 'Tab'); await act(() => Promise.resolve()) },
    hover: async (el: Element) => { fireEvent.mouseOver(el); await act(() => Promise.resolve()) },
  }

  return { render, screen, user, fireEvent, waitFor, act, cleanup }
}
