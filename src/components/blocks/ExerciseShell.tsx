import type { ReactNode } from 'react'
import { useProgress } from '../../engine/progress.ts'

const KIND: Record<string, { icon: string; label: string }> = {
  quiz: { icon: '❓', label: 'Quiz' },
  challenge: { icon: '⌨️', label: 'Code challenge' },
  tests: { icon: '🧪', label: 'Write the tests' },
  react: { icon: '⚛️', label: 'React challenge' },
  sql: { icon: '🐘', label: 'SQL challenge' },
  lab: { icon: '🔬', label: 'Hands-on lab' },
  cards: { icon: '🃏', label: 'Flashcards' },
}

export function ExerciseShell({ id, kind, cls, title, xp, children }: { id: string; kind: string; cls: string; title?: string; xp: number; children: ReactNode }) {
  const p = useProgress()
  const rec = p.exercises[id]
  const k = KIND[kind] || KIND.challenge
  return (
    <section className={`ex ex-${cls}${rec ? ' solved' : ''}`} id={`ex-${id}`} aria-label={`${k.label}${title ? `: ${title}` : ''}`}>
      <header className="ex-head">
        <span className="ex-kind"><span aria-hidden="true">{k.icon}</span>{k.label}</span>
        <span className="ex-title">{title}</span>
        {rec ? <span className="chip chip-ok">✓ +{rec.xp} XP</span> : <span className="chip chip-xp">{xp} XP</span>}
      </header>
      <div className="ex-body">{children}</div>
    </section>
  )
}
