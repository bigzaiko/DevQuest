import { useEffect, useState } from 'react'
import type { CardsBlock } from '../../engine/parse.ts'
import { useProgress, markCardSeen, solveExercise } from '../../engine/progress.ts'
import { Markdown } from './Markdown.tsx'
import { ExerciseShell } from './ExerciseShell.tsx'

export function Cards({ b }: { b: CardsBlock }) {
  const p = useProgress()
  const seen = p.cardsSeen[b.id] || []
  const [i, setI] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const card = b.cards[i]

  useEffect(() => {
    if (!p.exercises[b.id] && b.cards.every((_, k) => seen.includes(k))) solveExercise(b.id, b.xp, `Flashcards: ${b.title}`)
  }, [seen.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const flip = () => { setFlipped((f) => !f); if (!flipped) markCardSeen(b.id, i) }
  const go = (d: number) => { setFlipped(false); setI((x) => (x + d + b.cards.length) % b.cards.length) }

  return (
    <ExerciseShell id={b.id} kind="cards" cls="cards" xp={b.xp} title={b.title}>
      <div className="deck">
        <button type="button" className={`flip${flipped ? ' flipped' : ''}`} onClick={flip} aria-label={flipped ? 'Show question' : 'Reveal answer'}
          onKeyDown={(e) => { if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1) }}>
          <span className="flip-inner">
            <span className="face face-q" aria-hidden={flipped}><small>Question {i + 1} / {b.cards.length}</small><Markdown md={card.q} inline className="" /><small style={{ marginTop: 'auto' }}>click to flip</small></span>
            <span className="face face-a" aria-hidden={!flipped}><small>Answer</small><Markdown md={card.a} /></span>
          </span>
        </button>
        <div className="deck-nav">
          <button className="btn btn-sm" type="button" onClick={() => go(-1)} aria-label="Previous card">←</button>
          <div className="dots" aria-label={`${seen.length} of ${b.cards.length} cards seen`}>
            {b.cards.map((_, k) => <i key={k} className={`${seen.includes(k) ? 'seen' : ''}${k === i ? ' cur' : ''}`} />)}
          </div>
          <button className="btn btn-sm" type="button" onClick={() => go(1)} aria-label="Next card">→</button>
        </div>
      </div>
    </ExerciseShell>
  )
}
