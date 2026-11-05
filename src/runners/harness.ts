// A tiny Jest/Vitest-compatible test harness. Runs in a Web Worker, an iframe, or Node (validator).
// Erasable TypeScript only.

export interface TestResult { name: string; pass: boolean; error?: string; ms: number }
export interface RunResult { results: TestResult[]; logs: string[]; compileError?: string; fatal?: string }

type Fn = () => unknown | Promise<unknown>

export class AssertionError extends Error {}

function fmt(v: unknown, depth = 0): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`
  if (typeof v === 'undefined') return 'undefined'
  if (typeof v === 'bigint') return `${v}n`
  if (typeof v === 'symbol') return v.toString()
  if (v === null || typeof v !== 'object') return String(v)
  if (typeof Element !== 'undefined' && v instanceof Element) {
    const html = v.outerHTML
    return html.length > 160 ? html.slice(0, 160) + '…' : html
  }
  if (v instanceof Error) return `${v.name}: ${v.message}`
  if (depth > 3) return Array.isArray(v) ? '[…]' : '{…}'
  if (v instanceof Map) return `Map(${fmt([...v.entries()], depth + 1)})`
  if (v instanceof Set) return `Set(${fmt([...v.values()], depth + 1)})`
  if (Array.isArray(v)) return `[${v.map((x) => fmt(x, depth + 1)).join(', ')}]`
  if (v instanceof Date) return `Date(${v.toISOString()})`
  const entries = Object.entries(v as Record<string, unknown>)
  return `{ ${entries.map(([k, x]) => `${k}: ${fmt(x, depth + 1)}`).join(', ')} }`
}

export function deepEqual(a: unknown, b: unknown, strict = false): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k), strict)) return false
    return true
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  const ka = Object.keys(a as object).filter((k) => strict || (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => strict || (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], strict)) return false
  return true
}

function matchObject(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return deepEqual(actual, expected)
  if (actual === null || typeof actual !== 'object') return false
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchObject(actual[i], e))
  }
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => matchObject((actual as Record<string, unknown>)[k], v))
}

export interface Mock {
  (...args: unknown[]): unknown
  mock: { calls: unknown[][]; results: unknown[] }
  mockImplementation(f: (...a: unknown[]) => unknown): Mock
  mockReturnValue(v: unknown): Mock
  mockResolvedValue(v: unknown): Mock
  mockClear(): Mock
  __isMock: true
}

export function fn(impl?: (...a: unknown[]) => unknown): Mock {
  let cur = impl
  const m = function (this: unknown, ...args: unknown[]) {
    m.mock.calls.push(args)
    const r = cur ? cur.apply(this, args) : undefined
    m.mock.results.push(r)
    return r
  } as Mock
  m.mock = { calls: [], results: [] }
  m.mockImplementation = (f) => { cur = f; return m }
  m.mockReturnValue = (v) => { cur = () => v; return m }
  m.mockResolvedValue = (v) => { cur = () => Promise.resolve(v); return m }
  m.mockClear = () => { m.mock.calls = []; m.mock.results = []; return m }
  m.__isMock = true
  return m
}

const isEl = (x: unknown): x is Element => typeof Element !== 'undefined' && x instanceof Element

function textOf(el: Element) { return (el.textContent || '').replace(/\s+/g, ' ').trim() }

export function makeExpect() {
  function build(actual: unknown, negate: boolean, mode: '' | 'resolves' | 'rejects'): Record<string, unknown> {
    const check = (pass: boolean, msg: string, msgNot?: string) => {
      if (pass === negate) throw new AssertionError(negate ? (msgNot || `Expected NOT: ${msg}`) : msg)
    }
    const a = actual
    const matchers: Record<string, (...args: never[]) => void> = {
      toBe: (e: unknown) => check(Object.is(a, e), `expected ${fmt(a)} to be ${fmt(e)}`, `expected ${fmt(a)} not to be ${fmt(e)}`),
      toEqual: (e: unknown) => check(deepEqual(a, e), `expected ${fmt(a)} to equal ${fmt(e)}`, `expected ${fmt(a)} not to equal ${fmt(e)}`),
      toStrictEqual: (e: unknown) => check(deepEqual(a, e, true), `expected ${fmt(a)} to strictly equal ${fmt(e)}`),
      toBeTruthy: () => check(!!a, `expected ${fmt(a)} to be truthy`, `expected ${fmt(a)} to be falsy`),
      toBeFalsy: () => check(!a, `expected ${fmt(a)} to be falsy`, `expected ${fmt(a)} to be truthy`),
      toBeNull: () => check(a === null, `expected ${fmt(a)} to be null`),
      toBeUndefined: () => check(a === undefined, `expected ${fmt(a)} to be undefined`),
      toBeDefined: () => check(a !== undefined, `expected value to be defined`),
      toBeNaN: () => check(Number.isNaN(a), `expected ${fmt(a)} to be NaN`),
      toContain: (e: unknown) => check(
        typeof a === 'string' ? a.includes(String(e)) : Array.isArray(a) ? a.includes(e) : false,
        `expected ${fmt(a)} to contain ${fmt(e)}`),
      toContainEqual: (e: unknown) => check(Array.isArray(a) && a.some((x) => deepEqual(x, e)), `expected ${fmt(a)} to contain equal ${fmt(e)}`),
      toHaveLength: (n: number) => check((a as { length?: number })?.length === n, `expected length ${n}, got ${(a as { length?: number })?.length} (${fmt(a)})`),
      toBeGreaterThan: (n: number) => check((a as number) > n, `expected ${fmt(a)} > ${n}`),
      toBeGreaterThanOrEqual: (n: number) => check((a as number) >= n, `expected ${fmt(a)} >= ${n}`),
      toBeLessThan: (n: number) => check((a as number) < n, `expected ${fmt(a)} < ${n}`),
      toBeLessThanOrEqual: (n: number) => check((a as number) <= n, `expected ${fmt(a)} <= ${n}`),
      toBeCloseTo: (n: number, digits = 2) => check(Math.abs((a as number) - n) < Math.pow(10, -digits) / 2, `expected ${fmt(a)} to be close to ${n}`),
      toMatch: (re: RegExp | string) => check(typeof a === 'string' && (typeof re === 'string' ? a.includes(re) : re.test(a)), `expected ${fmt(a)} to match ${String(re)}`),
      toBeInstanceOf: (C: new (...x: unknown[]) => unknown) => check(a instanceof C, `expected value to be instance of ${C.name}`),
      toHaveProperty: (k: string, v?: unknown) => {
        let cur: unknown = a
        let ok = true
        for (const part of k.split('.')) {
          if (cur != null && typeof cur === 'object' && part in (cur as object)) cur = (cur as Record<string, unknown>)[part]
          else { ok = false; break }
        }
        if (ok && v !== undefined) ok = deepEqual(cur, v)
        check(ok, `expected ${fmt(a)} to have property ${k}${v !== undefined ? ` = ${fmt(v)}` : ''}`)
      },
      toMatchObject: (e: unknown) => check(matchObject(a, e), `expected ${fmt(a)} to match object ${fmt(e)}`),
      toThrow: (e?: string | RegExp | (new (...x: unknown[]) => Error)) => {
        if (mode === 'rejects') {
          const err = a as Error
          const ok = e === undefined ? true : typeof e === 'string' ? String(err?.message ?? err).includes(e) : e instanceof RegExp ? e.test(String(err?.message ?? err)) : err instanceof e
          check(ok, `expected rejection matching ${String(e)}, got ${fmt(err)}`)
          return
        }
        if (typeof a !== 'function') throw new AssertionError('toThrow expects a function: expect(() => …).toThrow()')
        let thrown: unknown = null
        let did = false
        try { (a as () => unknown)() } catch (err) { did = true; thrown = err }
        let ok = did
        if (did && e !== undefined) {
          const msg = String((thrown as Error)?.message ?? thrown)
          ok = typeof e === 'string' ? msg.includes(e) : e instanceof RegExp ? e.test(msg) : thrown instanceof e
        }
        check(ok, did ? `expected error matching ${String(e)}, got ${fmt(thrown)}` : 'expected function to throw', `expected function not to throw, but it threw ${fmt(thrown)}`)
      },
      toHaveBeenCalled: () => check(!!(a as Mock)?.mock?.calls.length, `expected mock to have been called`, `expected mock not to have been called`),
      toHaveBeenCalledTimes: (n: number) => check((a as Mock)?.mock?.calls.length === n, `expected mock to be called ${n} times, got ${(a as Mock)?.mock?.calls.length}`),
      toHaveBeenCalledWith: (...args: unknown[]) => check(!!(a as Mock)?.mock?.calls.some((c) => deepEqual(c, args)),
        `expected mock to have been called with ${fmt(args)}; calls: ${fmt((a as Mock)?.mock?.calls)}`),
      // DOM matchers
      toBeInTheDocument: () => check(isEl(a) && a.isConnected, `expected element to be in the document`, `expected element not to be in the document`),
      toHaveTextContent: (t: string | RegExp) => {
        const txt = isEl(a) ? textOf(a) : ''
        check(typeof t === 'string' ? txt.includes(t) : t.test(txt), `expected element text ${fmt(txt)} to contain ${String(t)}`)
      },
      toHaveValue: (v: unknown) => {
        const el = a as HTMLInputElement
        const val = el?.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el?.value
        check(deepEqual(val, v), `expected element value ${fmt(val)} to be ${fmt(v)}`)
      },
      toBeDisabled: () => check(isEl(a) && (a as HTMLButtonElement).disabled === true, `expected element to be disabled`, `expected element not to be disabled`),
      toBeEnabled: () => check(isEl(a) && !(a as HTMLButtonElement).disabled, `expected element to be enabled`),
      toBeChecked: () => check(isEl(a) && ((a as HTMLInputElement).checked || a.getAttribute('aria-checked') === 'true'), `expected element to be checked`),
      toHaveAttribute: (n: string, v?: string) => check(isEl(a) && a.hasAttribute(n) && (v === undefined || a.getAttribute(n) === v),
        `expected element to have attribute ${n}${v !== undefined ? `="${v}"` : ''}, got ${isEl(a) ? fmt(a.getAttribute(n)) : 'non-element'}`),
      toHaveClass: (...names: string[]) => check(isEl(a) && names.every((n) => a.classList.contains(n)), `expected element to have class ${names.join(' ')}, got "${isEl(a) ? a.className : ''}"`),
      toHaveFocus: () => check(isEl(a) && a.ownerDocument.activeElement === a, `expected element to have focus (focused: ${fmt(typeof document !== 'undefined' ? document.activeElement : null)})`),
    }
    return matchers
  }

  function expect(actual: unknown) {
    const m = build(actual, false, '') as Record<string, unknown>
    m.not = build(actual, true, '')
    const wrapAsync = (kind: 'resolves' | 'rejects', negate: boolean) => new Proxy({}, {
      get: (_t, prop: string) => async (...args: unknown[]) => {
        let value: unknown
        if (kind === 'resolves') value = await (actual as Promise<unknown>)
        else {
          let rejected = false
          try { await (actual as Promise<unknown>) } catch (e) { rejected = true; value = e }
          if (!rejected) throw new AssertionError('expected promise to reject')
        }
        const target = build(value, negate, kind)
        return (target[prop] as (...a: unknown[]) => void)(...args)
      },
    })
    m.resolves = wrapAsync('resolves', false)
    m.rejects = wrapAsync('rejects', false)
    return m as any // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  return expect
}

export interface Registry {
  tests: { name: string; fn: Fn }[]
  beforeEach: Fn[]
  afterEach: Fn[]
  prefix: string[]
}

export function makeRegistry() {
  const reg: Registry = { tests: [], beforeEach: [], afterEach: [], prefix: [] }
  const test = (name: string, f: Fn) => { reg.tests.push({ name: [...reg.prefix, name].join(' › '), fn: f }) }
  const describe = (name: string, f: () => void) => { reg.prefix.push(name); try { f() } finally { reg.prefix.pop() } }
  const beforeEach = (f: Fn) => { reg.beforeEach.push(f) }
  const afterEach = (f: Fn) => { reg.afterEach.push(f) }
  return { reg, test, describe, beforeEach, afterEach }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

export async function runRegistry(reg: Registry, hooks: { before?: Fn; after?: Fn } = {}, perTestMs = 3000): Promise<TestResult[]> {
  const results: TestResult[] = []
  for (const t of reg.tests) {
    const start = Date.now()
    try {
      if (hooks.before) await hooks.before()
      for (const b of reg.beforeEach) await b()
      await withTimeout(Promise.resolve().then(t.fn), perTestMs, `test "${t.name}"`)
      for (const b of reg.afterEach) await b()
      results.push({ name: t.name, pass: true, ms: Date.now() - start })
    } catch (e) {
      const err = e as Error
      results.push({ name: t.name, pass: false, error: err instanceof AssertionError ? err.message : `${err?.name || 'Error'}: ${err?.message ?? String(e)}`, ms: Date.now() - start })
    } finally {
      try { if (hooks.after) await hooks.after() } catch { /* ignore */ }
    }
  }
  return results
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export { fmt }
