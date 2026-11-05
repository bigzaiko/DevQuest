import type { CSSProperties } from 'react'
import { TRACKS, ROUTE } from '../content/tracks.ts'
import { LESSONS, LESSONS_BY_TRACK, ROUTE_LESSONS, TOTAL_MINUTES, TRACK_BY_ID, trackStats, EXERCISES } from '../content/index.ts'
import { useProgress, levelOf, rankOf, streakOf } from '../engine/progress.ts'
import { href } from '../router.ts'
import { ExamGrid } from './Exam.tsx'

export function Home() {
  const p = useProgress()
  const lv = levelOf(p.xp)
  const rank = rankOf(lv.level)
  const next = ROUTE_LESSONS.find((l) => !p.lessons[l.meta.id])
  const nextTrack = next ? TRACK_BY_ID.get(next.track) : undefined
  const doneLessons = Object.keys(p.lessons).filter((id) => LESSONS.some((l) => l.meta.id === id)).length
  const started = Object.keys(p.exercises).length > 0 || doneLessons > 0
  const recommendedTrack = ROUTE.find((t) => (LESSONS_BY_TRACK.get(t) || []).some((l) => !p.lessons[l.meta.id]))

  return (
    <div className="page">
      <section className="hero">
        <div>
          <div className="eyebrow">Full-stack academy · beginner → expert</div>
          <h1>Level up from <em>first component</em> to production architect.</h1>
          <p className="lead">
            React 19 + Vite + TypeScript, C# &amp; ASP.NET Core 10, PostgreSQL, Docker and Kubernetes — explained properly,
            practised with real tests, real SQL on a real Postgres in your browser, and hands-on labs that mirror what a new job throws at you.
          </p>
          <div className="hero-actions">
            {next && (
              <a className="btn btn-primary" href={href.lesson(next.meta.id)}>{started ? '▶ Continue quest' : '▶ Start the quest'}</a>
            )}
            <a className="btn" href="#/exam/all">🎓 Test my level</a>
            <a className="btn btn-ghost" href={href.playground()}>🐘 SQL playground</a>
          </div>
        </div>
        <div className="hero-card">
          <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'center', marginBottom: '1rem' }}>
            <span className="level-badge" style={{ '--s': '58px', fontSize: '1.4rem' } as CSSProperties}>{lv.level}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800 }}>{p.name || 'Adventurer'} · {rank.icon} {rank.title}</div>
              <div className="xpbar" style={{ margin: '0.4rem 0 0.25rem' }}><i style={{ width: `${lv.pct * 100}%` }} /></div>
              <div className="hud-xp">{lv.into} / {lv.span} XP to level {lv.level + 1}</div>
            </div>
          </div>
          <div className="stat-grid">
            <div className="stat"><b>{doneLessons}<small style={{ fontSize: '0.9rem', color: 'var(--muted)' }}> / {LESSONS.length}</small></b><span>lessons complete</span></div>
            <div className="stat"><b>{Object.keys(p.exercises).length}<small style={{ fontSize: '0.9rem', color: 'var(--muted)' }}> / {EXERCISES.size}</small></b><span>exercises solved</span></div>
            <div className="stat"><b>🔥 {streakOf(p.days)}</b><span>day streak</span></div>
            <div className="stat"><b>~{Math.round(TOTAL_MINUTES / 60)}h</b><span>of training content</span></div>
          </div>
          {next && nextTrack && (
            <a className="continue-card" href={href.lesson(next.meta.id)}>
              <span className="ci">{nextTrack.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}><small>Up next · {nextTrack.title}</small><b>{next.meta.title}</b></span>
              <span aria-hidden="true">→</span>
            </a>
          )}
        </div>
      </section>

      <div className="section-title" id="realms">
        <h2>The world map</h2>
        <p>Follow the route left-to-right — or jump anywhere to refresh a topic.</p>
      </div>
      <div className="realm-grid">
        {TRACKS.map((t) => {
          const s = trackStats(t.id)
          const list = LESSONS_BY_TRACK.get(t.id) || []
          const done = list.filter((l) => p.lessons[l.meta.id]).length
          const style = { '--track': t.color } as CSSProperties
          const body = (
            <>
              <div className="realm-top">
                <span className="realm-icon" aria-hidden="true">{t.icon}</span>
                <span className="realm-name"><small>{t.realm}</small><b>{t.title}</b></span>
              </div>
              <p>{t.tagline}</p>
              <div className="realm-foot">
                {t.soon ? <span>Coming soon</span> : (
                  <>
                    <span>{s.lessons} lessons · ~{Math.round(s.minutes / 60 * 10) / 10}h</span>
                    <span className="realm-progress" aria-label={`${done} of ${s.lessons} complete`}><i style={{ width: `${s.lessons ? (done / s.lessons) * 100 : 0}%` }} /></span>
                    <span>{done}/{s.lessons}</span>
                  </>
                )}
              </div>
              {t.soon && <span className="ribbon">Soon</span>}
            </>
          )
          return t.soon
            ? <div key={t.id} className="realm soon" style={style} aria-disabled="true">{body}</div>
            : <a key={t.id} className={`realm${recommendedTrack === t.id ? ' recommended' : ''}`} style={style} href={href.track(t.id)}>{body}</a>
        })}
      </div>

      <div className="section-title" id="exams">
        <h2>🎓 Skill checks</h2>
        <p>Random questions across all levels — find your level, or prove you've mastered a region.</p>
      </div>
      <ExamGrid />

      <div className="section-title"><h2>How to train</h2></div>
      <div className="grid-4">
        <div className="panel"><h3>📖 Read</h3><p className="ex-note">Every lesson explains the <i>why</i> first, with real-world examples and "on the job" notes.</p></div>
        <div className="panel"><h3>⌨️ Code</h3><p className="ex-note">JS/TS and React challenges run against real tests in a browser sandbox. Some ask <i>you</i> to write the tests.</p></div>
        <div className="panel"><h3>🐘 Query</h3><p className="ex-note">SQL runs on PostgreSQL 18 compiled to WebAssembly — real errors, real query plans.</p></div>
        <div className="panel"><h3>🔬 Build</h3><p className="ex-note">Labs walk you through C#, Docker and Kubernetes on your machine, with tests to prove it works.</p></div>
      </div>
    </div>
  )
}
