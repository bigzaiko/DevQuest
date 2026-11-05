import type { Progress } from './progress.ts'
import { EXERCISES, LESSONS, LESSONS_BY_TRACK } from '../content/index.ts'
import { TRACKS } from '../content/tracks.ts'

export interface Achievement { id: string; icon: string; title: string; desc: string; test: (p: Progress) => boolean; secret?: boolean }

const solvedOfKind = (p: Progress, kind: string, pred: (e: unknown) => boolean = () => true) =>
  Object.keys(p.exercises).filter((id) => { const e = EXERCISES.get(id); return e?.kind === kind && pred(e) }).length

const levelOfXp = (xp: number) => { let l = 1; while (25 * (l + 1) * l <= xp) l++; return l }
const streak = (days: string[]) => {
  const set = new Set(days); let n = 0; const d = new Date()
  const k = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  if (!set.has(k(d))) d.setDate(d.getDate() - 1)
  while (set.has(k(d))) { n++; d.setDate(d.getDate() - 1) }
  return n
}
const trackDone = (p: Progress, t: string) => { const l = LESSONS_BY_TRACK.get(t) || []; return l.length > 0 && l.every((x) => p.lessons[x.meta.id]) }

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-step', icon: '👣', title: 'First Step', desc: 'Solve your first exercise.', test: (p) => Object.keys(p.exercises).length >= 1 },
  { id: 'first-lesson', icon: '📘', title: 'Class Dismissed', desc: 'Complete your first lesson.', test: (p) => Object.keys(p.lessons).length >= 1 },
  { id: 'green-bar', icon: '✅', title: 'Green Bar', desc: 'Pass your first code challenge.', test: (p) => solvedOfKind(p, 'challenge') >= 1 },
  { id: 'react-hand', icon: '⚛️', title: 'React Hands', desc: 'Pass 10 React component challenges.', test: (p) => solvedOfKind(p, 'challenge', (e) => (e as { react: boolean }).react) >= 10 },
  { id: 'tester', icon: '🧪', title: 'Bug Hunter', desc: 'Write tests that catch every mutant in a challenge.', test: (p) => solvedOfKind(p, 'challenge', (e) => (e as { mode: string }).mode === 'tests') >= 1 },
  { id: 'mutant-slayer', icon: '🧬', title: 'Mutant Slayer', desc: 'Solve 5 write-the-tests challenges.', test: (p) => solvedOfKind(p, 'challenge', (e) => (e as { mode: string }).mode === 'tests') >= 5 },
  { id: 'select-star', icon: '🐘', title: 'SELECT *', desc: 'Solve your first SQL challenge.', test: (p) => solvedOfKind(p, 'sql') >= 1 },
  { id: 'query-master', icon: '🔍', title: 'Query Master', desc: 'Solve 30 SQL challenges.', test: (p) => solvedOfKind(p, 'sql') >= 30 },
  { id: 'quiz-ace', icon: '🎯', title: 'Sharpshooter', desc: 'Get 25 exercises right on the first try.', test: (p) => p.stats.firstTry >= 25 },
  { id: 'lab-rat', icon: '🔬', title: 'Lab Rat', desc: 'Finish 5 hands-on labs.', test: (p) => solvedOfKind(p, 'lab') >= 5 },
  { id: 'lab-legend', icon: '🏗️', title: 'Builder', desc: 'Finish 25 hands-on labs.', test: (p) => solvedOfKind(p, 'lab') >= 25 },
  { id: 'card-shark', icon: '🃏', title: 'Card Shark', desc: 'Flip through 15 flashcard decks.', test: (p) => solvedOfKind(p, 'cards') >= 15 },
  { id: 'streak-3', icon: '🔥', title: 'On Fire', desc: 'Train 3 days in a row.', test: (p) => streak(p.days) >= 3 },
  { id: 'streak-7', icon: '🌋', title: 'Unstoppable', desc: 'Train 7 days in a row.', test: (p) => streak(p.days) >= 7 },
  { id: 'level-5', icon: '⭐', title: 'Rising Star', desc: 'Reach level 5.', test: (p) => levelOfXp(p.xp) >= 5 },
  { id: 'level-15', icon: '🌟', title: 'Seasoned', desc: 'Reach level 15.', test: (p) => levelOfXp(p.xp) >= 15 },
  { id: 'level-30', icon: '💫', title: 'Grandmaster', desc: 'Reach level 30.', test: (p) => levelOfXp(p.xp) >= 30 },
  { id: 'full-stack', icon: '🥞', title: 'Full Stack', desc: 'Complete a lesson in Frontend, Database, Backend and Containers.',
    test: (p) => ['frontend', 'database', 'backend', 'ops'].every((t) => (LESSONS_BY_TRACK.get(t) || []).some((l) => p.lessons[l.meta.id])) },
  { id: 'boss-slayer', icon: '🗡️', title: 'Boss Slayer', desc: 'Complete a boss lesson.', test: (p) => LESSONS.some((l) => l.boss && p.lessons[l.meta.id]) },
  { id: 'night-owl', icon: '🦉', title: 'Night Owl', desc: 'Solve something between midnight and 4 am.', secret: true,
    test: (p) => Object.values(p.exercises).some((r) => { const h = new Date(r.at).getHours(); return h < 4 }) },
  ...TRACKS.filter((t) => !t.soon).map((t) => ({
    id: `track-${t.id}`, icon: t.icon, title: `${t.realm} Conquered`, desc: `Complete every lesson in ${t.title}.`, test: (p: Progress) => trackDone(p, t.id),
  })),
  { id: 'examinee', icon: '📝', title: 'Examinee', desc: 'Finish your first skill check.', test: (p) => (p.examRuns || 0) >= 1 },
  { id: 'certified', icon: '🎓', title: 'Certified', desc: 'Score 80% or more in a region skill check.', test: (p) => Object.entries(p.exams || {}).some(([k, r]) => k !== 'all' && r.score >= 80) },
  { id: 'expert-verified', icon: '🧠', title: 'Verified Expert', desc: 'Reach the "expert" estimate in any skill check.', test: (p) => Object.values(p.exams || {}).some((r) => r.level === 'expert') },
  { id: 'grand-master', icon: '🏛️', title: 'Grand Trial', desc: 'Score 80% or more in the Final Exam.', test: (p) => (p.exams?.all?.score ?? 0) >= 80 },
  { id: 'completionist', icon: '👑', title: 'Legend of DevQuest', desc: 'Complete every lesson in every region.', test: (p) => LESSONS.length > 0 && LESSONS.every((l) => p.lessons[l.meta.id]) },
]

export const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))
