// Lesson parser — shared by the site (Vite) and the Node validator (type-stripped TS).
// Keep this file to erasable TypeScript only (no enums, no parameter properties).

export type Level = 'beginner' | 'intermediate' | 'advanced' | 'expert'
export const LEVELS: Level[] = ['beginner', 'intermediate', 'advanced', 'expert']

export interface LessonMeta {
  id: string
  title: string
  level: Level
  minutes: number
  xp: number
  summary: string
}

export type CalloutVariant = 'tip' | 'info' | 'warn' | 'pro' | 'job'
export const CALLOUTS: CalloutVariant[] = ['tip', 'info', 'warn', 'pro', 'job']

export interface MdBlock { kind: 'md'; md: string }
export interface CalloutBlock { kind: 'callout'; variant: CalloutVariant; title?: string; md: string }
export interface QuizBlock {
  kind: 'quiz'; id: string; xp: number
  question: string
  options: { md: string; correct: boolean }[]
  explanation: string
  multi: boolean
}
export interface ChallengeBlock {
  kind: 'challenge'; id: string; xp: number; title: string
  lang: 'js' | 'ts' | 'jsx' | 'tsx'
  react: boolean
  mode: 'code' | 'tests'
  preview?: string
  prompt: string
  hints: string[]
  starter: string; solution: string; tests: string; setup: string
  impl: string; mutants: string[]
}
export interface SqlBlock {
  kind: 'sql'; id: string; xp: number; title: string
  db: string; ordered: boolean
  prompt: string; hints: string[]
  starter: string; solution: string; setup: string; check: string
}
export interface LabBlock {
  kind: 'lab'; id: string; xp: number; title: string
  body: (MdBlock | CalloutBlock)[]
  checklist: string[]
}
export interface CardsBlock {
  kind: 'cards'; id: string; xp: number; title: string
  cards: { q: string; a: string }[]
}

export type Exercise = QuizBlock | ChallengeBlock | SqlBlock | LabBlock | CardsBlock
export type Block = MdBlock | CalloutBlock | Exercise

export interface ParsedLesson {
  meta: LessonMeta
  blocks: Block[]
  exercises: Exercise[]
  errors: string[]
}

// ───────────────────────── helpers ─────────────────────────

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w-]+)=("([^"]*)"|'([^']*)'|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1]] = m[3] ?? m[4] ?? m[5] ?? ''
  return out
}

function parseFrontmatter(src: string, errors: string[]): { meta: LessonMeta; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  const raw: Record<string, string> = {}
  let body = src
  if (!m) errors.push('missing frontmatter')
  else {
    body = src.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(\w+):\s*(.*)$/.exec(line)
      if (kv) raw[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  for (const k of ['id', 'title', 'level', 'minutes', 'xp', 'summary']) if (!raw[k]) errors.push(`frontmatter: missing "${k}"`)
  const level = (raw.level || 'beginner') as Level
  if (!LEVELS.includes(level)) errors.push(`frontmatter: bad level "${raw.level}"`)
  return {
    meta: {
      id: raw.id || 'unknown',
      title: raw.title || 'Untitled',
      level,
      minutes: Number(raw.minutes) || 10,
      xp: Number(raw.xp) || 50,
      summary: raw.summary || '',
    },
    body,
  }
}

interface RawDirective { name: string; attrs: Record<string, string>; lines: string[]; line: number }
type Segment = { type: 'md'; lines: string[] } | { type: 'dir'; dir: RawDirective }

/** Split markdown into plain segments and top-level directives (fence aware, nesting aware). */
function segment(lines: string[], baseLine = 0): Segment[] {
  const out: Segment[] = []
  let md: string[] = []
  let fence: string | null = null
  let i = 0
  const flush = () => { if (md.length) { out.push({ type: 'md', lines: md }); md = [] } }
  while (i < lines.length) {
    const line = lines[i]
    const f = FENCE_RE.exec(line)
    if (fence) {
      md.push(line)
      if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3].trim()) fence = null
      i++; continue
    }
    if (f) { fence = f[2]; md.push(line); i++; continue }
    const open = /^:::(\w+)\s*(.*)$/.exec(line)
    if (open) {
      flush()
      const dir: RawDirective = { name: open[1], attrs: parseAttrs(open[2]), lines: [], line: baseLine + i + 1 }
      let depth = 1
      let inFence: string | null = null
      i++
      while (i < lines.length) {
        const l = lines[i]
        const ff = FENCE_RE.exec(l)
        if (inFence) {
          if (ff && ff[2][0] === inFence[0] && ff[2].length >= inFence.length && !ff[3].trim()) inFence = null
        } else if (ff) inFence = ff[2]
        else if (/^:::\w+/.test(l)) depth++
        else if (/^:::\s*$/.test(l)) { depth--; if (depth === 0) break }
        dir.lines.push(l)
        i++
      }
      if (depth !== 0) dir.attrs.__unclosed = '1'
      i++ // skip closing :::
      out.push({ type: 'dir', dir })
      continue
    }
    md.push(line)
    i++
  }
  flush()
  return out
}

interface Extracted { text: string[]; fences: { lang: string; role: string; code: string }[]; keyed: Record<string, string[]> }

/** Pull out role-tagged fences and `key:` lines at the top level of a directive body. */
function extract(lines: string[], roles: string[], keys: string[]): Extracted {
  const text: string[] = []
  const fences: Extracted['fences'] = []
  const keyed: Record<string, string[]> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const f = FENCE_RE.exec(line)
    if (f) {
      const info = f[3].trim().split(/\s+/)
      const role = info.length > 1 ? info[info.length - 1] : ''
      const body: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const g = FENCE_RE.exec(lines[j])
        if (g && g[2][0] === f[2][0] && g[2].length >= f[2].length && !g[3].trim()) break
        body.push(lines[j]); j++
      }
      if (roles.includes(role)) fences.push({ lang: info[0], role, code: dedent(body, f[1].length).join('\n') })
      else text.push(...lines.slice(i, j + 1))
      i = j + 1
      continue
    }
    const k = /^(\w+):\s?(.*)$/.exec(line)
    if (k && keys.includes(k[1])) { (keyed[k[1]] ||= []).push(k[2].trim()); i++; continue }
    text.push(line)
    i++
  }
  return { text, fences, keyed }
}

function dedent(lines: string[], n: number): string[] {
  if (!n) return lines
  return lines.map((l) => (l.slice(0, n).trim() === '' ? l.slice(n) : l))
}

const trimMd = (lines: string[]) => lines.join('\n').trim()

// ───────────────────────── main ─────────────────────────

export function parseLesson(src: string): ParsedLesson {
  const errors: string[] = []
  const { meta, body } = parseFrontmatter(src.replace(/\r\n/g, '\n'), errors)
  const blocks = parseBlocks(body.split('\n'), errors, meta.id, true)
  const exercises = blocks.filter((b): b is Exercise => b.kind !== 'md' && b.kind !== 'callout')
  return { meta, blocks, exercises, errors }
}

function parseBlocks(lines: string[], errors: string[], lessonId: string, allowExercises: boolean): Block[] {
  const blocks: Block[] = []
  for (const seg of segment(lines)) {
    if (seg.type === 'md') {
      const md = trimMd(seg.lines)
      if (md) blocks.push({ kind: 'md', md })
      continue
    }
    const d = seg.dir
    const where = `${lessonId}: :::${d.name} (line ~${d.line})`
    if (d.attrs.__unclosed) errors.push(`${where}: not closed with :::`)
    if ((CALLOUTS as string[]).includes(d.name)) {
      blocks.push({ kind: 'callout', variant: d.name as CalloutVariant, title: d.attrs.title, md: trimMd(d.lines) })
      continue
    }
    if (!allowExercises) { errors.push(`${where}: only callouts may be nested here`); continue }
    const id = d.attrs.id
    if (!id) errors.push(`${where}: missing id`)
    const xp = Number(d.attrs.xp) || 0
    try {
      if (d.name === 'quiz') blocks.push(parseQuiz(d, id, xp || 10, where, errors))
      else if (d.name === 'challenge') blocks.push(parseChallenge(d, id, xp || 40, where, errors))
      else if (d.name === 'sql') blocks.push(parseSql(d, id, xp || 30, where, errors))
      else if (d.name === 'lab') blocks.push(parseLab(d, id, xp || 80, where, errors, lessonId))
      else if (d.name === 'cards') blocks.push(parseCards(d, id, xp || 15, where, errors))
      else errors.push(`${where}: unknown directive`)
    } catch (e) {
      errors.push(`${where}: ${(e as Error).message}`)
    }
  }
  return blocks
}

function parseQuiz(d: RawDirective, id: string, xp: number, where: string, errors: string[]): QuizBlock {
  const q: string[] = []
  const options: QuizBlock['options'] = []
  const expl: string[] = []
  let fence: string | null = null
  for (const line of d.lines) {
    const f = FENCE_RE.exec(line)
    if (fence) { q.push(line); if (f && f[2][0] === fence[0] && !f[3].trim()) fence = null; continue }
    if (f) { fence = f[2]; q.push(line); continue }
    const o = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line)
    if (o) { options.push({ md: o[2], correct: o[1] !== ' ' }); continue }
    const e = /^>\s?(.*)$/.exec(line)
    if (e) { expl.push(e[1]); continue }
    q.push(line)
  }
  const nCorrect = options.filter((o) => o.correct).length
  if (options.length < 2) errors.push(`${where}: quiz needs ≥2 options`)
  if (nCorrect < 1) errors.push(`${where}: quiz needs ≥1 correct option`)
  return { kind: 'quiz', id, xp, question: trimMd(q), options, explanation: expl.join('\n').trim(), multi: nCorrect > 1 }
}

function parseChallenge(d: RawDirective, id: string, xp: number, where: string, errors: string[]): ChallengeBlock {
  const ex = extract(d.lines, ['starter', 'solution', 'tests', 'setup', 'impl', 'mutant'], ['title', 'hint'])
  const get = (r: string) => ex.fences.find((f) => f.role === r)?.code ?? ''
  const lang = (d.attrs.lang || 'js') as ChallengeBlock['lang']
  if (!['js', 'ts', 'jsx', 'tsx'].includes(lang)) errors.push(`${where}: bad lang "${lang}"`)
  const mode = d.attrs.mode === 'tests' ? 'tests' : 'code'
  const c: ChallengeBlock = {
    kind: 'challenge', id, xp,
    title: ex.keyed.title?.[0] || d.attrs.title || 'Challenge',
    lang, react: lang === 'jsx' || lang === 'tsx' || d.attrs.react === 'true',
    mode, preview: d.attrs.preview,
    prompt: trimMd(ex.text), hints: ex.keyed.hint || [],
    starter: get('starter'), solution: get('solution'), tests: get('tests'), setup: get('setup'),
    impl: get('impl'), mutants: ex.fences.filter((f) => f.role === 'mutant').map((f) => f.code),
  }
  if (!c.solution) errors.push(`${where}: missing \`solution\` fence`)
  if (mode === 'code' && !c.tests) errors.push(`${where}: missing \`tests\` fence`)
  if (mode === 'tests' && (!c.impl || !c.mutants.length)) errors.push(`${where}: mode=tests needs \`impl\` and ≥1 \`mutant\``)
  return c
}

function parseSql(d: RawDirective, id: string, xp: number, where: string, errors: string[]): SqlBlock {
  const ex = extract(d.lines, ['starter', 'solution', 'setup', 'check'], ['title', 'hint'])
  const get = (r: string) => ex.fences.find((f) => f.role === r)?.code ?? ''
  const s: SqlBlock = {
    kind: 'sql', id, xp,
    title: ex.keyed.title?.[0] || d.attrs.title || 'SQL challenge',
    db: d.attrs.db || 'shop', ordered: d.attrs.ordered === 'true',
    prompt: trimMd(ex.text), hints: ex.keyed.hint || [],
    starter: get('starter'), solution: get('solution'), setup: get('setup'), check: get('check'),
  }
  if (!s.solution) errors.push(`${where}: missing \`solution\` fence`)
  return s
}

function parseLab(d: RawDirective, id: string, xp: number, where: string, errors: string[], lessonId: string): LabBlock {
  const checklist: string[] = []
  const rest: string[] = []
  let fence: string | null = null
  let title = d.attrs.title || ''
  let depth = 0
  for (const line of d.lines) {
    const f = FENCE_RE.exec(line)
    if (fence) { rest.push(line); if (f && f[2][0] === fence[0] && !f[3].trim()) fence = null; continue }
    if (f) { fence = f[2]; rest.push(line); continue }
    if (/^:::\w+/.test(line)) depth++
    else if (/^:::\s*$/.test(line)) depth--
    const t = /^title:\s*(.*)$/.exec(line)
    if (depth === 0 && t && !title) { title = t[1].trim(); continue }
    const c = /^[-*]\s+\[ \]\s+(.*)$/.exec(line)
    if (depth === 0 && c) { checklist.push(c[1]); continue }
    rest.push(line)
  }
  if (!checklist.length) errors.push(`${where}: lab needs a "- [ ]" checklist`)
  const body = parseBlocks(rest, errors, lessonId, false) as (MdBlock | CalloutBlock)[]
  return { kind: 'lab', id, xp, title: title || 'Lab', body, checklist }
}

function parseCards(d: RawDirective, id: string, xp: number, where: string, errors: string[]): CardsBlock {
  const cards: CardsBlock['cards'] = []
  let cur: { q: string; a: string[] } | null = null
  let inA = false
  for (const line of d.lines) {
    const q = /^Q:\s*(.*)$/.exec(line)
    if (q) { if (cur) cards.push({ q: cur.q, a: cur.a.join('\n').trim() }); cur = { q: q[1], a: [] }; inA = false; continue }
    const a = /^A:\s*(.*)$/.exec(line)
    if (a && cur) { cur.a.push(a[1]); inA = true; continue }
    if (cur && inA) cur.a.push(line.replace(/^ {3}/, ''))
  }
  if (cur) cards.push({ q: cur.q, a: cur.a.join('\n').trim() })
  if (!cards.length) errors.push(`${where}: no Q:/A: cards`)
  return { kind: 'cards', id, xp, title: d.attrs.title || 'Flashcards', cards }
}

/** Total XP available in a lesson (lesson completion + all exercises). */
export function lessonMaxXp(l: ParsedLesson): number {
  return l.meta.xp + l.exercises.reduce((s, e) => s + e.xp, 0)
}
