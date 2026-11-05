import type { LabBlock } from '../../engine/parse.ts'
import { useProgress, setLabCheck, solveExercise } from '../../engine/progress.ts'
import { Markdown } from './Markdown.tsx'
import { Callout } from './Callout.tsx'
import { ExerciseShell } from './ExerciseShell.tsx'

export function Lab({ b }: { b: LabBlock }) {
  const p = useProgress()
  const solved = !!p.exercises[b.id]
  const checks = p.labChecks[b.id] || []
  const all = b.checklist.every((_, i) => checks[i])
  return (
    <ExerciseShell id={b.id} kind="lab" cls="lab" xp={b.xp} title={b.title}>
      {b.body.map((x, i) => (x.kind === 'md' ? <Markdown key={i} md={x.md} /> : <Callout key={i} b={x} />))}
      <div className="checklist-head">Acceptance checklist</div>
      <ul className="checklist">
        {b.checklist.map((c, i) => (
          <li key={i}>
            <label className={checks[i] ? 'checked' : ''}>
              <input type="checkbox" checked={!!checks[i]} onChange={(e) => setLabCheck(b.id, b.checklist.length, i, e.target.checked)} />
              <Markdown md={c} inline className="" />
            </label>
          </li>
        ))}
      </ul>
      <div className="ex-actions">
        <button className="btn btn-primary" type="button" disabled={!all || solved} onClick={() => solveExercise(b.id, b.xp, `Lab: ${b.title}`)}>
          {solved ? '✓ Lab complete' : all ? '🏁 Claim lab XP' : `Tick all ${b.checklist.length} items to finish`}
        </button>
        <span className="ex-note">Labs run on your machine — be honest with yourself, it's your training. 😉</span>
      </div>
    </ExerciseShell>
  )
}
