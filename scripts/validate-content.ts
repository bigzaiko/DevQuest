// Validates every lesson: parses it, checks ids, runs every challenge solution against its tests
// (JS/TS/React in jsdom, SQL in PGlite). Usage:
//   npm run validate                 # everything
//   npm run validate -- frontend/0 frontend/1   # only files whose path contains any of these
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { parseLesson, type ChallengeBlock, type SqlBlock } from '../src/engine/parse.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contentDir = join(root, 'src/content')
const filters = process.argv.slice(2)

// ── DOM globals for React challenges ──
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
process.on('unhandledRejection', () => { /* a buggy starter/mutant left a rejected promise — the test result already reflects it */ })
const g = globalThis as Record<string, unknown>
// DOM classes always come from jsdom (Node has its own Event/CustomEvent that jsdom elements reject).
for (const k of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLFormElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'InputEvent', 'CustomEvent', 'UIEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'DocumentFragment', 'Text', 'CSS', 'localStorage', 'sessionStorage', 'matchMedia', 'FormData', 'File', 'Blob', 'DOMParser', 'HTMLDialogElement', 'SubmitEvent']) {
  const v = (dom.window as unknown as Record<string, unknown>)[k]
  if (v === undefined) continue
  try { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) } catch { /* readonly */ }
}
if (!g.matchMedia) g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
if (!g.CSS) g.CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') }

const React = await import('react')
const ReactDOMClient = await import('react-dom/client')
const { createDomKit } = await import('../src/runners/dom.ts')
const { runChallenge } = await import('../src/runners/execute.ts')
const { gradeSql } = await import('../src/runners/sql.ts')
const { PGlite } = await import('@electric-sql/pglite')
const kit = createDomKit(React, ReactDOMClient, dom.window.document)

// Silence React's act() environment warnings in the validator output.
const origError = console.error
console.error = (...a: unknown[]) => { const s = String(a[0] ?? ''); if (s.includes('act(') || s.includes('ReactDOMTestUtils')) return; origError(...a) }

const datasets: Record<string, string> = {}
for (const f of readdirSync(join(contentDir, 'datasets'))) if (f.endsWith('.sql')) datasets[f.replace(/\.sql$/, '')] = readFileSync(join(contentDir, 'datasets', f), 'utf8')
const dataset = (n: string) => { if (!(n in datasets)) throw new Error(`unknown dataset "${n}"`); return datasets[n] }

const PREFIX: Record<string, string> = { basecamp: 'bc', frontend: 'fe', backend: 'be', database: 'db', ops: 'ops', pro: 'pro', capstone: 'cap', desktop: 'dsk', cloud: 'cl' }
// private regions (gitignored, local only) declare their prefix in _track.json
for (const d of readdirSync(contentDir)) {
  if (!d.startsWith('private-')) continue
  try { PREFIX[d] = JSON.parse(readFileSync(join(contentDir, d, '_track.json'), 'utf8')).prefix } catch { console.log(`  ✖ ${d}: missing or invalid _track.json`); process.exitCode = 1 }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : []
  })
}

const files = walk(contentDir).filter((f) => (!filters.length || filters.some((x) => relative(contentDir, f).includes(x)))).sort()
let errors = 0
let warnings = 0
const lessonIds = new Map<string, string>()
const exIds = new Map<string, string>()
let nChallenges = 0, nSql = 0, nQuiz = 0, nLab = 0, nCards = 0, totalMinutes = 0

const err = (file: string, msg: string) => { errors++; console.log(`  ✖ ${file}: ${msg}`) }
const warn = (file: string, msg: string) => { warnings++; console.log(`  ⚠ ${file}: ${msg}`) }

for (const file of files) {
  const rel = relative(contentDir, file)
  const track = rel.split('/')[0]
  const lesson = parseLesson(readFileSync(file, 'utf8'))
  totalMinutes += lesson.meta.minutes
  for (const e of lesson.errors) err(rel, e)
  if (lessonIds.has(lesson.meta.id)) err(rel, `duplicate lesson id "${lesson.meta.id}" (also in ${lessonIds.get(lesson.meta.id)})`)
  lessonIds.set(lesson.meta.id, rel)
  const pre = PREFIX[track]
  if (pre && !lesson.meta.id.startsWith(pre + '-')) err(rel, `lesson id "${lesson.meta.id}" should start with "${pre}-"`)
  if (lesson.exercises.length < 2) warn(rel, `only ${lesson.exercises.length} interactive piece(s); aim for ≥2`)
  if (/^#\s/m.test(lesson.blocks.filter((b) => b.kind === 'md').map((b) => (b as { md: string }).md).join('\n').replace(/```[\s\S]*?```/g, ''))) warn(rel, 'contains a "# " h1 heading; use ## and below')

  for (const ex of lesson.exercises) {
    if (exIds.has(ex.id)) err(rel, `duplicate exercise id "${ex.id}" (also in ${exIds.get(ex.id)})`)
    exIds.set(ex.id, rel)
    if (!ex.id.startsWith(lesson.meta.id + '-')) warn(rel, `exercise id "${ex.id}" should start with "${lesson.meta.id}-"`)
    if (ex.kind === 'quiz') { nQuiz++; if (!(ex as { explanation: string }).explanation) warn(rel, `[${ex.id}] quiz has no "> explanation" line`) }
    if (ex.kind === 'lab') nLab++
    if (ex.kind === 'cards') nCards++

    if (ex.kind === 'challenge') {
      nChallenges++
      const ch = ex as ChallengeBlock
      try {
        const env = ch.react ? { React, ReactDOMClient, dom: kit } : {}
        const v = await runChallenge(ch, ch.solution, env)
        if (!v.pass) {
          const failing = v.results.filter((r) => !r.pass).map((r) => `\n      - ${r.name}: ${r.error}`).join('')
          const mut = v.mutants?.map((m, i) => (m.caught ? '' : `\n      - mutant #${i + 1} NOT caught by solution tests`)).join('') || ''
          err(rel, `[${ch.id}] solution does not pass. ${v.error ?? ''}${failing}${mut}`)
        }
        if (ch.starter) {
          const s = await runChallenge(ch, ch.starter, env)
          if (s.pass) err(rel, `[${ch.id}] starter already passes — tests are too weak`)
        } else warn(rel, `[${ch.id}] no starter`)
      } catch (e) {
        err(rel, `[${ch.id}] crashed: ${(e as Error).stack}`)
      }
    }

    if (ex.kind === 'sql') {
      nSql++
      const s = ex as SqlBlock
      try {
        const r = await gradeSql(PGlite, s, s.solution, dataset)
        if (!r.pass) err(rel, `[${s.id}] solution failed: ${r.reason}`)
        const rows = r.expected?.rows.length ?? 0
        if (!s.check && rows === 0) warn(rel, `[${s.id}] solution returns 0 rows — is that intended?`)
        if (s.starter) {
          const st = await gradeSql(PGlite, s, s.starter, dataset)
          if (st.pass) err(rel, `[${s.id}] starter already passes`)
        }
      } catch (e) {
        err(rel, `[${s.id}] crashed: ${(e as Error).message}`)
      }
    }
  }
}

console.log(`\n${files.length} lessons · ${nQuiz} quizzes · ${nChallenges} code challenges · ${nSql} SQL challenges · ${nLab} labs · ${nCards} card decks · ~${Math.round(totalMinutes / 60)}h`)
console.log(errors ? `✖ ${errors} error(s), ${warnings} warning(s)` : `✔ all good (${warnings} warning(s))`)
process.exit(errors ? 1 : 0)
