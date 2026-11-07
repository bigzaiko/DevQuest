// Compile + run a challenge. Shared by the Web Worker, the React iframe sandbox and the Node validator.
import { transform } from 'sucrase'
import { fn, makeExpect, makeRegistry, runRegistry, sleep, fmt, type RunResult, type TestResult } from './harness.ts'
import type { DomKit } from './dom.ts'

export interface ChallengeInput {
  lang: 'js' | 'ts' | 'jsx' | 'tsx'
  react: boolean
  mode: 'code' | 'tests'
  setup: string
  impl: string
  mutants: string[]
  tests: string
}

export interface Verdict {
  pass: boolean
  results: TestResult[]
  logs: string[]
  error?: string
  /** mode=tests: which mutants were caught */
  mutants?: { caught: boolean; failing: string[] }[]
}

export function compile(src: string, react: boolean): string {
  return transform(src, {
    transforms: react ? ['typescript', 'jsx', 'imports'] : ['typescript', 'imports'],
    jsxRuntime: 'classic',
    production: true,
    disableESTransforms: true,
  }).code
}

const REACT_GLOBALS = ['useState', 'useEffect', 'useLayoutEffect', 'useRef', 'useReducer', 'useContext', 'createContext', 'useMemo', 'useCallback', 'useId',
  'useTransition', 'useDeferredValue', 'useSyncExternalStore', 'useActionState', 'useOptimistic', 'Fragment', 'memo', 'forwardRef', 'Children', 'cloneElement', 'isValidElement', 'createElement']

export interface Env {
  React?: unknown
  ReactDOMClient?: unknown
  dom?: DomKit
}

/** Run `code` + `tests` in one scope and return per-test results. */
export async function runOnce(code: string, tests: string, react: boolean, env: Env): Promise<RunResult> {
  const logs: string[] = []
  const log = (...a: unknown[]) => { if (logs.length < 200) logs.push(a.map((x) => (typeof x === 'string' ? x : fmt(x))).join(' ')) }
  const consoleProxy = { log, info: log, warn: (...a: unknown[]) => log('⚠', ...a), error: (...a: unknown[]) => log('✖', ...a), debug: log, table: log }
  let js: string
  try {
    js = compile(code, react) + '\n;\n' + compile(tests, react)
  } catch (e) {
    return { results: [], logs, compileError: (e as Error).message }
  }
  const modules: Record<string, unknown> = {}
  if (env.React) { modules.react = env.React }
  if (env.ReactDOMClient) { modules['react-dom/client'] = env.ReactDOMClient; modules['react-dom'] = env.ReactDOMClient }
  const require = (name: string) => {
    if (name in modules) return modules[name]
    throw new Error(`Module "${name}" is not available in challenges (only 'react').`)
  }
  const { reg, test, describe, beforeEach, afterEach } = makeRegistry()
  const expect = makeExpect()
  const dom = env.dom
  const scope: Record<string, unknown> = {
    React: env.React, require, exports: {}, module: { exports: {} },
    test, it: test, describe, beforeEach, afterEach, expect, fn, vi: { fn }, jest: { fn }, sleep,
    console: consoleProxy,
    render: dom?.render, screen: dom?.screen, user: dom?.user, fireEvent: dom?.fireEvent, waitFor: dom?.waitFor, act: dom?.act, cleanup: dom?.cleanup,
  }
  // React hooks/APIs as bare globals too, so helper components inside `tests` can use them
  // (user code's `import { useState } from 'react'` compiles to `_react.useState`, invisible to tests).
  // Skipped for any name the code itself declares at top level, to avoid a redeclaration error.
  if (env.React) {
    const R = env.React as Record<string, unknown>
    for (const k of REACT_GLOBALS) {
      if (k in R && !new RegExp(`(^|[^.\\w$])(const|let|var|function|class)\\s+${k}\\b`).test(js)) scope[k] = R[k]
    }
  }
  const names = Object.keys(scope)
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const f = new Function(...names, js)
    f(...names.map((n) => scope[n]))
  } catch (e) {
    const err = e as Error
    return { results: [], logs, fatal: `${err?.name || 'Error'}: ${err?.message ?? String(e)}` }
  }
  if (!reg.tests.length) return { results: [], logs, fatal: 'No tests were registered. Write at least one test(...)' }
  const results = await runRegistry(reg, dom ? { before: dom.cleanup, after: dom.cleanup } : {})
  return { results, logs }
}

export async function runChallenge(ch: ChallengeInput, userCode: string, env: Env): Promise<Verdict> {
  if (ch.mode === 'code') {
    const r = await runOnce((ch.setup ? ch.setup + '\n' : '') + userCode, ch.tests, ch.react, env)
    const error = r.compileError ? `Compile error: ${r.compileError}` : r.fatal
    return { pass: !error && r.results.length > 0 && r.results.every((t) => t.pass), results: r.results, logs: r.logs, error }
  }
  // mode=tests — the learner wrote the tests
  const base = await runOnce((ch.setup ? ch.setup + '\n' : '') + ch.impl, userCode, ch.react, env)
  const error = base.compileError ? `Compile error: ${base.compileError}` : base.fatal
  if (error) return { pass: false, results: base.results, logs: base.logs, error }
  const mutants: Verdict['mutants'] = []
  for (const m of ch.mutants) {
    const r = await runOnce((ch.setup ? ch.setup + '\n' : '') + m, userCode, ch.react, env)
    const failing = r.results.filter((t) => !t.pass).map((t) => t.name)
    mutants.push({ caught: !!(r.compileError || r.fatal) || failing.length > 0, failing })
  }
  const baseOk = base.results.length > 0 && base.results.every((t) => t.pass)
  return {
    pass: baseOk && mutants.every((m) => m.caught),
    results: base.results,
    logs: base.logs,
    error: baseOk ? undefined : 'Your tests must all pass against the correct implementation first.',
    mutants,
  }
}
