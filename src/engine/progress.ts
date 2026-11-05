// Game state: XP, levels, ranks, streaks, achievements. Persisted in localStorage.
import { useSyncExternalStore } from 'react'

export interface ExerciseRecord { xp: number; at: string }
export interface ExamResult { score: number; right: number; total: number; perLevel: Record<string, { right: number; total: number }>; level: string; seconds: number; at: string }
export interface Progress {
  version: 1
  xp: number
  exercises: Record<string, ExerciseRecord>      // solved exercises
  misses: Record<string, number>                 // wrong attempts before solving
  revealed: Record<string, true>                 // solution revealed before solving → half XP
  lessons: Record<string, { at: string; xp: number }>
  labChecks: Record<string, boolean[]>
  cardsSeen: Record<string, number[]>
  achievements: Record<string, string>
  days: string[]                                 // yyyy-mm-dd days with activity
  stats: { runs: number; sqlRuns: number; firstTry: number }
  exams: Record<string, ExamResult>             // best result per exam scope (track id or 'all')
  examRuns: number
  name: string
}

const KEY = 'devquest:progress:v1'
const DRAFTS = 'devquest:drafts:v1'

const empty = (): Progress => ({
  version: 1, xp: 0, exercises: {}, misses: {}, revealed: {}, lessons: {}, labChecks: {}, cardsSeen: {},
  achievements: {}, days: [], stats: { runs: 0, sqlRuns: 0, firstTry: 0 }, exams: {}, examRuns: 0, name: '',
})

function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const p = JSON.parse(raw)
    return { ...empty(), ...p, stats: { ...empty().stats, ...(p.stats || {}) } }
  } catch { return empty() }
}

let state: Progress = typeof localStorage !== 'undefined' ? load() : empty()
const listeners = new Set<() => void>()

function save() { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* quota */ } }
function emit() { listeners.forEach((l) => l()) }

export function getProgress() { return state }
export function useProgress(): Progress {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, () => state, () => state)
}

// ───────────── events (toasts, level-up) ─────────────
export type GameEvent =
  | { type: 'xp'; amount: number; label: string }
  | { type: 'level'; level: number; rank: string }
  | { type: 'achievement'; id: string }
const eventListeners = new Set<(e: GameEvent) => void>()
export function onGameEvent(f: (e: GameEvent) => void) { eventListeners.add(f); return () => { eventListeners.delete(f) } }
function fire(e: GameEvent) { eventListeners.forEach((f) => f(e)) }

// ───────────── levels & ranks ─────────────
/** Total XP needed to reach `level` (level 1 = 0 XP). Each level costs 50 × level more. */
export const xpForLevel = (level: number) => 25 * level * (level - 1)
export function levelOf(xp: number) {
  let l = 1
  while (xpForLevel(l + 1) <= xp) l++
  const base = xpForLevel(l)
  const next = xpForLevel(l + 1)
  return { level: l, into: xp - base, span: next - base, pct: (xp - base) / (next - base) }
}

export const RANKS: { level: number; title: string; icon: string }[] = [
  { level: 1, title: 'Intern', icon: '🥚' },
  { level: 3, title: 'Junior Developer', icon: '🐣' },
  { level: 7, title: 'Developer', icon: '🛠️' },
  { level: 12, title: 'Senior Developer', icon: '⚔️' },
  { level: 17, title: 'Tech Lead', icon: '🧙' },
  { level: 22, title: 'Staff Engineer', icon: '🦅' },
  { level: 27, title: 'Principal Engineer', icon: '🏰' },
  { level: 32, title: 'Architect', icon: '🐉' },
  { level: 37, title: 'Legend', icon: '👑' },
]
export function rankOf(level: number) {
  let r = RANKS[0]
  for (const x of RANKS) if (level >= x.level) r = x
  return r
}

// ───────────── streak ─────────────
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function streakOf(days: string[]) {
  const set = new Set(days)
  let n = 0
  const d = new Date()
  // today not active yet? the streak is still alive if yesterday was.
  const key = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  if (!set.has(key(d))) d.setDate(d.getDate() - 1)
  while (set.has(key(d))) { n++; d.setDate(d.getDate() - 1) }
  return n
}

// ───────────── mutations ─────────────
function update(mut: (p: Progress) => void, xpGained = 0, label = '') {
  const before = levelOf(state.xp).level
  const next: Progress = structuredClone(state)
  mut(next)
  const t = today()
  if (!next.days.includes(t)) next.days = [...next.days, t].slice(-400)
  state = next
  if (xpGained > 0) fire({ type: 'xp', amount: xpGained, label })
  const after = levelOf(state.xp).level
  if (after > before) fire({ type: 'level', level: after, rank: rankOf(after).title })
  checkAchievements()
  save()
  emit()
}

/** Award an exercise. Returns XP granted (0 if already solved). */
export function solveExercise(id: string, maxXp: number, label: string): number {
  if (state.exercises[id]) return 0
  const missed = (state.misses[id] || 0) > 0
  const revealed = !!state.revealed[id]
  const xp = Math.max(1, Math.round(maxXp * (revealed ? 0.25 : missed ? 0.5 : 1)))
  update((p) => {
    p.exercises[id] = { xp, at: new Date().toISOString() }
    p.xp += xp
    if (!missed && !revealed) p.stats.firstTry++
  }, xp, label)
  return xp
}

export function missExercise(id: string) {
  if (state.exercises[id]) return
  update((p) => { p.misses[id] = (p.misses[id] || 0) + 1 })
}
export function revealSolution(id: string) {
  if (state.exercises[id] || state.revealed[id]) return
  update((p) => { p.revealed[id] = true })
}
export function countRun(kind: 'code' | 'sql') {
  update((p) => { if (kind === 'sql') p.stats.sqlRuns++; else p.stats.runs++ })
}

export function completeLesson(id: string, xp: number, title: string, withXp = true) {
  if (state.lessons[id]) return
  const gained = withXp ? xp : 0
  update((p) => { p.lessons[id] = { at: new Date().toISOString(), xp: gained }; p.xp += gained }, gained, `Lesson complete: ${title}`)
}
export function uncompleteLesson(id: string) {
  const rec = state.lessons[id]
  if (!rec) return
  update((p) => { p.xp -= rec.xp; delete p.lessons[id] })
}

export function setLabCheck(id: string, n: number, i: number, v: boolean) {
  update((p) => {
    const arr = (p.labChecks[id] || Array(n).fill(false)).slice(0, n)
    while (arr.length < n) arr.push(false)
    arr[i] = v
    p.labChecks[id] = arr
  })
}
export function markCardSeen(id: string, i: number) {
  if (state.cardsSeen[id]?.includes(i)) return
  update((p) => { p.cardsSeen[id] = [...(p.cardsSeen[id] || []), i] })
}
/** Store an exam result; keeps the best score. XP = 3 per correct answer above your previous best. */
export function recordExam(scope: string, r: ExamResult, title: string) {
  const prev = state.exams[scope]
  const gained = Math.max(0, r.right - (prev?.right ?? 0)) * 3
  update((p) => {
    p.examRuns++
    if (!prev || r.score >= prev.score) p.exams[scope] = r
    p.xp += gained
  }, gained, `${title}: ${r.score}%`)
}

export function setName(name: string) { update((p) => { p.name = name.slice(0, 40) }) }

// ───────────── drafts (code you typed) ─────────────
let drafts: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem(DRAFTS) || '{}') } catch { return {} } })()
let draftTimer: ReturnType<typeof setTimeout> | undefined
export const getDraft = (id: string) => drafts[id]
export function setDraft(id: string, code: string) {
  drafts[id] = code
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => { try { localStorage.setItem(DRAFTS, JSON.stringify(drafts)) } catch { /* ignore */ } }, 400)
}
export function clearDraft(id: string) { delete drafts[id]; try { localStorage.setItem(DRAFTS, JSON.stringify(drafts)) } catch { /* ignore */ } }

// ───────────── export / import / reset ─────────────
export function exportProgress(): string {
  return JSON.stringify({ app: 'devquest', exportedAt: new Date().toISOString(), progress: state, drafts }, null, 2)
}
export function importProgress(json: string) {
  const data = JSON.parse(json)
  if (data?.app !== 'devquest' || !data.progress) throw new Error('Not a DevQuest export file.')
  state = { ...empty(), ...data.progress }
  drafts = data.drafts || {}
  save()
  localStorage.setItem(DRAFTS, JSON.stringify(drafts))
  emit()
}
export function resetProgress() {
  state = empty()
  drafts = {}
  save()
  localStorage.removeItem(DRAFTS)
  emit()
}

// ───────────── achievements ─────────────
import { ACHIEVEMENTS } from './achievements.ts'
function checkAchievements() {
  const newly: string[] = []
  for (const a of ACHIEVEMENTS) {
    if (state.achievements[a.id]) continue
    try { if (a.test(state)) newly.push(a.id) } catch { /* content not loaded */ }
  }
  if (!newly.length) return
  const at = new Date().toISOString()
  state = { ...state, achievements: { ...state.achievements, ...Object.fromEntries(newly.map((id) => [id, at])) } }
  for (const id of newly) fire({ type: 'achievement', id })
}
