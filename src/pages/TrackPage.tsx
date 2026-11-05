import type { CSSProperties } from 'react'
import { LEVELS } from '../engine/parse.ts'
import { LESSONS_BY_TRACK, TRACK_BY_ID, trackStats } from '../content/index.ts'
import { useProgress } from '../engine/progress.ts'
import { href } from '../router.ts'

const LEVEL_LABEL = { beginner: '🌱 Beginner', intermediate: '🌿 Intermediate', advanced: '🌳 Advanced', expert: '🐉 Expert' }

export function TrackPage({ id }: { id: string }) {
  const p = useProgress()
  const t = TRACK_BY_ID.get(id)
  const lessons = LESSONS_BY_TRACK.get(id) || []
  if (!t) return <div className="page"><h1>Unknown region</h1><a href={href.home()}>Back to the map</a></div>
  const s = trackStats(id)
  const done = lessons.filter((l) => p.lessons[l.meta.id]).length
  const current = lessons.find((l) => !p.lessons[l.meta.id])
  const earned = lessons.reduce((sum, l) => sum + (p.lessons[l.meta.id]?.xp || 0) + l.exercises.reduce((a, e) => a + (p.exercises[e.id]?.xp || 0), 0), 0)
  const style = { '--track': t.color } as CSSProperties

  // group by level, keeping file order
  const groups = LEVELS.map((lv) => ({ lv, items: lessons.filter((l) => l.meta.level === lv) })).filter((g) => g.items.length)

  return (
    <div className="page" style={style}>
      <div className="crumbs"><a href={href.home()}>Map</a> <span>›</span> <span>{t.title}</span></div>
      <section className="track-hero" style={style}>
        <span className="realm-icon" aria-hidden="true">{t.icon}</span>
        <div style={{ flex: 1 }}>
          <div className="eyebrow" style={{ color: t.color }}>{t.realm}</div>
          <h1>{t.title}</h1>
          <p>{t.tagline}</p>
          <div className="track-stats">
            <span><b>{done}</b>/{s.lessons} lessons</span>
            <span><b>{s.exercises}</b> exercises</span>
            <span>~<b>{Math.round(s.minutes / 6) / 10}</b> hours</span>
            <span><b>{earned}</b>/{s.xp} XP</span>
          </div>
        </div>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          {current && <a className="btn btn-primary" href={href.lesson(current.meta.id)}>{done ? '▶ Continue' : '▶ Start'}</a>}
          <a className="btn" href={href.exam(id)}>🎓 Skill check{p.exams?.[id] ? ` · ${p.exams[id].score}%` : ''}</a>
        </div>
      </section>
      {!lessons.length && <p>Lessons for this region are being written.</p>}
      {groups.map((g) => (
        <div key={g.lv}>
          <div className="tier"><h2>{LEVEL_LABEL[g.lv]}</h2></div>
          <div className="path">
            {g.items.map((l) => {
              const isDone = !!p.lessons[l.meta.id]
              const solved = l.exercises.filter((e) => p.exercises[e.id]).length
              const cls = ['node', isDone && 'done', current === l && 'current', l.boss && 'boss'].filter(Boolean).join(' ')
              return (
                <a key={l.meta.id} className={cls} data-n={l.index + 1} href={href.lesson(l.meta.id)}>
                  <span className="node-title">{l.meta.title}</span>
                  <span className="node-sum">{l.meta.summary}</span>
                  <span className="node-meta">
                    <span>⏱ {l.meta.minutes} min · ✨ {l.maxXp} XP</span>
                    <span className="mini-bar" aria-label={`${solved} of ${l.exercises.length} exercises solved`}><i style={{ width: `${l.exercises.length ? (solved / l.exercises.length) * 100 : 0}%` }} /></span>
                  </span>
                </a>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
