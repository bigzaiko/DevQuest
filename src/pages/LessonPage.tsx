import { useEffect, useState, type CSSProperties } from 'react'
import { BY_ID, LESSONS_BY_TRACK, TRACK_BY_ID, loadLesson } from '../content/index.ts'
import type { Block, ParsedLesson } from '../engine/parse.ts'
import { useProgress, completeLesson, uncompleteLesson } from '../engine/progress.ts'
import { slugify } from '../engine/markdown.ts'
import { preloadPostgres } from '../runners/client.ts'
import { href } from '../router.ts'
import { Markdown } from '../components/blocks/Markdown.tsx'
import { Callout } from '../components/blocks/Callout.tsx'
import { Quiz } from '../components/blocks/Quiz.tsx'
import { Challenge } from '../components/blocks/Challenge.tsx'
import { SqlChallenge } from '../components/blocks/SqlChallenge.tsx'
import { Lab } from '../components/blocks/Lab.tsx'
import { Cards } from '../components/blocks/Cards.tsx'

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'md': return <Markdown md={b.md} />
    case 'callout': return <Callout b={b} />
    case 'quiz': return <Quiz b={b} />
    case 'challenge': return <Challenge b={b} />
    case 'sql': return <SqlChallenge b={b} />
    case 'lab': return <Lab b={b} />
    case 'cards': return <Cards b={b} />
  }
}

const KIND_ICON: Record<string, string> = { quiz: '❓', challenge: '⌨️', sql: '🐘', lab: '🔬', cards: '🃏' }

export function LessonPage({ id }: { id: string }) {
  const p = useProgress()
  const l = BY_ID.get(id)
  const [full, setFull] = useState<ParsedLesson | null>(null)
  const [loadErr, setLoadErr] = useState('')
  useEffect(() => { if (l) loadLesson(id).then(setFull, (e) => setLoadErr(String(e?.message ?? e))) }, [id, l])
  useEffect(() => { if (l?.exercises.some((e) => e.kind === 'sql')) preloadPostgres() }, [l])
  useEffect(() => { if (l) document.title = `${l.meta.title} · DevQuest` ; return () => { document.title = 'DevQuest — Full-Stack Academy' } }, [l])
  if (!l) return <div className="page"><h1>Lesson not found</h1><a href={href.home()}>Back to the map</a></div>

  const t = TRACK_BY_ID.get(l.track)
  const list = LESSONS_BY_TRACK.get(l.track) || []
  const prev = list[l.index - 1]
  const next = list[l.index + 1]
  const solved = l.exercises.filter((e) => p.exercises[e.id]).length
  const allSolved = solved === l.exercises.length
  const done = !!p.lessons[l.meta.id]
  const style = { '--track': t?.color } as CSSProperties
  const headings = l.headings

  return (
    <div className="lesson-layout" style={style}>
      <article className="lesson">
        <div className="crumbs">
          <a href={href.home()}>Map</a><span>›</span><a href={href.track(l.track)}>{t?.icon} {t?.title}</a><span>›</span><span>Lesson {l.index + 1}</span>
        </div>
        <header className="lesson-head">
          <div className="chips">
            <span className={`chip chip-level-${l.meta.level}`}>{l.meta.level}</span>
            <span className="chip">⏱ {l.meta.minutes} min</span>
            <span className="chip chip-xp">✨ {l.maxXp} XP</span>
            {l.boss && <span className="chip" style={{ color: 'var(--flare)' }}>🐉 Boss</span>}
            {done && <span className="chip chip-ok">✓ Complete</span>}
          </div>
          <h1>{l.meta.title}</h1>
          <p>{l.meta.summary}</p>
        </header>

        {loadErr && <p role="alert">Could not load this lesson: {loadErr}</p>}
        {!full && !loadErr && <div className="booting"><span className="spinner" /> Loading lesson…</div>}
        {full?.blocks.map((b, i) => <BlockView key={i} b={b} />)}

        <section className="finish">
          {done ? (
            <>
              <h3>✓ Lesson complete</h3>
              <p>{next ? 'On to the next one.' : 'You finished this region! Pick your next one on the map.'}</p>
              <div className="row">
                {next ? <a className="btn btn-primary" href={href.lesson(next.meta.id)}>Next: {next.meta.title} →</a> : <a className="btn btn-primary" href={href.home()}>🗺️ Back to the map</a>}
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => uncompleteLesson(l.meta.id)}>Mark as not done</button>
              </div>
            </>
          ) : (
            <>
              <h3>{allSolved ? '🏁 Finish the lesson' : `${solved}/${l.exercises.length} exercises solved`}</h3>
              <p>{allSolved ? `Collect the +${l.meta.xp} XP completion bonus.` : 'Solve every exercise to unlock the completion bonus.'}</p>
              <div className="row">
                <button className="btn btn-primary" type="button" disabled={!allSolved} onClick={() => completeLesson(l.meta.id, l.meta.xp, l.meta.title)}>
                  Complete lesson (+{l.meta.xp} XP)
                </button>
                {!allSolved && (
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => completeLesson(l.meta.id, l.meta.xp, l.meta.title, false)}>
                    I know this already — mark done (no bonus)
                  </button>
                )}
              </div>
            </>
          )}
        </section>

        <nav className="pager" aria-label="Lesson navigation">
          {prev ? <a href={href.lesson(prev.meta.id)}><small>← Previous</small>{prev.meta.title}</a> : <span />}
          {next ? <a className="next" href={href.lesson(next.meta.id)}><small>Next →</small>{next.meta.title}</a> : <span />}
        </nav>
      </article>

      <aside className="side" aria-label="Lesson sidebar">
        <div className="side-card">
          <h4>Progress</h4>
          <div className="xpbar" style={{ marginBottom: '0.4rem' }}><i style={{ width: `${l.exercises.length ? (solved / l.exercises.length) * 100 : 0}%` }} /></div>
          <div className="ex-note">{solved}/{l.exercises.length} exercises · {done ? 'complete' : 'in progress'}</div>
        </div>
        {headings.length > 0 && (
          <div className="side-card">
            <h4>On this page</h4>
            <ul className="toc">
              {headings.map((h) => <li key={h}><a href={href.lesson(l.meta.id, slugify(h.replace(/[*_`]/g, '')))}>{h.replace(/[*_`]/g, '')}</a></li>)}
            </ul>
          </div>
        )}
        <div className="side-card">
          <h4>Exercises</h4>
          <ul className="toc">
            {l.exercises.map((e) => (
              <li key={e.id}>
                <a href={href.lesson(l.meta.id, `ex-${e.id}`)}>
                  <span className={`ex-dot${p.exercises[e.id] ? ' on' : ''}`} />{KIND_ICON[e.kind]} {'title' in e ? e.title : 'Quiz'}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  )
}
