// Content index. The map needs only lesson summaries (built by the `?meta` Vite plugin in
// vite.config.ts); the full lesson Markdown is loaded on demand when a lesson is opened.
import { parseLesson, type ParsedLesson, type LessonMeta } from '../engine/parse.ts'
import { TRACKS, ROUTE, type Track } from './tracks.ts'

export interface ExerciseInfo { id: string; kind: 'quiz' | 'challenge' | 'sql' | 'lab' | 'cards'; xp: number; title?: string; react?: boolean; mode?: 'code' | 'tests' }
export interface Lesson {
  meta: LessonMeta
  maxXp: number
  errors: string[]
  headings: string[]
  exercises: ExerciseInfo[]
  track: string
  file: string
  index: number      // position in its track
  boss: boolean
}

const metas = import.meta.glob('./*/*.md', { query: '?meta', import: 'default', eager: true }) as Record<string, Omit<Lesson, 'track' | 'file' | 'index' | 'boss'>>
const bodies = import.meta.glob('./*/*.md', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>
const datasetFiles = import.meta.glob('./datasets/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export const LESSONS: Lesson[] = []
export const BY_ID = new Map<string, Lesson>()
export const EXERCISES = new Map<string, ExerciseInfo>()
const PATH_BY_ID = new Map<string, string>()

for (const path of Object.keys(metas).sort()) {
  const [, track, file] = /^\.\/([^/]+)\/(.+)$/.exec(path) || []
  if (!track || track === 'datasets') continue
  const m = metas[path]
  if (m.errors.length && import.meta.env.DEV) console.warn(`[content] ${path}`, m.errors)
  LESSONS.push({ ...m, track, file, index: 0, boss: /boss/.test(file) })
  PATH_BY_ID.set(m.meta.id, path)
}

export const LESSONS_BY_TRACK = new Map<string, Lesson[]>()
for (const t of TRACKS) LESSONS_BY_TRACK.set(t.id, [])
for (const l of LESSONS) {
  if (!LESSONS_BY_TRACK.has(l.track)) LESSONS_BY_TRACK.set(l.track, [])
  const list = LESSONS_BY_TRACK.get(l.track)!
  l.index = list.length
  list.push(l)
  BY_ID.set(l.meta.id, l)
  for (const e of l.exercises) EXERCISES.set(e.id, e)
}

const parsed = new Map<string, Promise<ParsedLesson>>()
/** Load + parse a lesson's full content (cached). */
export function loadLesson(id: string): Promise<ParsedLesson> {
  let p = parsed.get(id)
  if (!p) {
    const path = PATH_BY_ID.get(id)
    if (!path) return Promise.reject(new Error(`Unknown lesson ${id}`))
    const load = bodies[path]
    p = load()
      .catch(() => new Promise<string>((r) => setTimeout(r, 400)).then(() => load())) // one retry (flaky network)
      .then(parseLesson)
      .catch((e) => {
        parsed.delete(id)
        // a missing chunk after a redeploy → reload once to get the new build
        if (/dynamically imported module|Failed to fetch|Importing a module script failed/i.test(String(e?.message ?? e))) {
          try {
            const last = Number(sessionStorage.getItem('devquest:reloaded') || 0)
            if (Date.now() - last > 30_000) { sessionStorage.setItem('devquest:reloaded', String(Date.now())); location.reload() }
          } catch { location.reload() }
        }
        throw e
      })
    parsed.set(id, p)
  }
  return p
}

/** Lessons in the recommended order across all regions. */
export const ROUTE_LESSONS: Lesson[] = ROUTE.flatMap((t) => LESSONS_BY_TRACK.get(t) || [])

export const TRACK_BY_ID = new Map<string, Track>(TRACKS.map((t) => [t.id, t]))

export const DATASETS: Record<string, string> = Object.fromEntries(
  Object.entries(datasetFiles).map(([p, sql]) => [p.replace(/^.*\/(.+)\.sql$/, '$1'), sql]),
)

export const TOTAL_MINUTES = LESSONS.reduce((s, l) => s + l.meta.minutes, 0)
export const TOTAL_XP = LESSONS.reduce((s, l) => s + l.maxXp, 0)

export function trackStats(trackId: string) {
  const list = LESSONS_BY_TRACK.get(trackId) || []
  return {
    lessons: list.length,
    minutes: list.reduce((s, l) => s + l.meta.minutes, 0),
    exercises: list.reduce((s, l) => s + l.exercises.length, 0),
    xp: list.reduce((s, l) => s + l.maxXp, 0),
  }
}
