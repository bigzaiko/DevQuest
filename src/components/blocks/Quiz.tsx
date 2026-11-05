import { useState } from 'react'
import type { QuizBlock } from '../../engine/parse.ts'
import { useProgress, solveExercise, missExercise } from '../../engine/progress.ts'
import { Markdown } from './Markdown.tsx'
import { ExerciseShell } from './ExerciseShell.tsx'

const KEYS = 'ABCDEFGH'

export function Quiz({ b }: { b: QuizBlock }) {
  const p = useProgress()
  const solved = !!p.exercises[b.id]
  const [picked, setPicked] = useState<number[]>(() => (solved ? b.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0) : []))
  const [checked, setChecked] = useState(solved)
  const [wrong, setWrong] = useState(false)

  const isRight = (sel: number[]) => b.options.every((o, i) => o.correct === sel.includes(i))

  const submit = (sel: number[]) => {
    setChecked(true)
    if (isRight(sel)) { setWrong(false); solveExercise(b.id, b.xp, 'Quiz answered') }
    else { setWrong(true); missExercise(b.id) }
  }

  const choose = (i: number) => {
    if (solved || (checked && !wrong)) return
    if (b.multi) {
      setChecked(false)
      setPicked((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))
    } else {
      setPicked([i])
      submit([i])
    }
  }

  const done = checked && !wrong
  return (
    <ExerciseShell id={b.id} kind="quiz" cls="quiz" xp={b.xp} title={b.multi ? 'Select all that apply' : undefined}>
      <Markdown md={b.question} />
      <div className="options" role="group" aria-label="Answers">
        {b.options.map((o, i) => {
          const sel = picked.includes(i)
          let cls = 'option'
          if (checked && sel) cls += o.correct ? ' correct' : ' wrong'
          if (done && o.correct) cls += ' correct'
          return (
            <button key={i} type="button" className={cls} aria-pressed={sel} disabled={done || solved} onClick={() => choose(i)}>
              <span className="key">{KEYS[i]}</span>
              <Markdown md={o.md} inline className="" />
            </button>
          )
        })}
      </div>
      {b.multi && !done && !solved && (
        <div className="ex-actions">
          <button className="btn btn-primary btn-sm" disabled={!picked.length} onClick={() => submit(picked)}>Check answer</button>
        </div>
      )}
      {checked && wrong && <p className="ex-note" role="alert">Not quite — try again (now worth half XP).</p>}
      {(done || solved) && b.explanation && <div className="explain"><Markdown md={b.explanation} /></div>}
    </ExerciseShell>
  )
}
