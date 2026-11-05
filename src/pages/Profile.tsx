import { useRef, type CSSProperties } from 'react'
import { useProgress, levelOf, rankOf, streakOf, RANKS, setName, exportProgress, importProgress, resetProgress } from '../engine/progress.ts'
import { ACHIEVEMENTS } from '../engine/achievements.ts'
import { TRACKS } from '../content/tracks.ts'
import { LESSONS_BY_TRACK, EXERCISES, LESSONS } from '../content/index.ts'
import { href } from '../router.ts'
import { ExamGrid } from './Exam.tsx'

export function Profile() {
  const p = useProgress()
  const lv = levelOf(p.xp)
  const rank = rankOf(lv.level)
  const file = useRef<HTMLInputElement>(null)
  const kinds = ['quiz', 'challenge', 'sql', 'lab', 'cards'] as const
  const byKind = Object.fromEntries(kinds.map((k) => [k, Object.keys(p.exercises).filter((id) => EXERCISES.get(id)?.kind === k).length]))
  const totalByKind = Object.fromEntries(kinds.map((k) => [k, [...EXERCISES.values()].filter((e) => e.kind === k).length]))
  const days = new Set(p.days)
  const heat = Array.from({ length: 53 * 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (53 * 7 - 1 - i))
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return days.has(k)
  })

  const doExport = () => {
    const blob = new Blob([exportProgress()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `devquest-progress-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const doImport = async (f: File) => {
    try { importProgress(await f.text()); alert('Progress imported ✓') } catch (e) { alert(`Import failed: ${(e as Error).message}`) }
  }

  return (
    <div className="page">
      <section className="profile-head">
        <span className="level-badge">{lv.level}</span>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label className="sr-only" htmlFor="pname">Your name</label>
          <input id="pname" defaultValue={p.name} placeholder="Name your adventurer" onBlur={(e) => setName(e.target.value)} />
          <div style={{ color: 'var(--text-2)', fontWeight: 700, margin: '0.2rem 0 0.6rem 0.3rem' }}>{rank.icon} {rank.title} · {p.xp} XP · 🔥 {streakOf(p.days)}-day streak</div>
          <div className="xpbar" style={{ maxWidth: 420 }}><i style={{ width: `${lv.pct * 100}%` }} /></div>
          <div className="hud-xp" style={{ marginTop: 4 }}>{lv.into}/{lv.span} XP to level {lv.level + 1}</div>
        </div>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <button className="btn btn-sm" type="button" onClick={doExport}>⬇ Export progress</button>
          <button className="btn btn-sm" type="button" onClick={() => file.current?.click()}>⬆ Import progress</button>
          <input ref={file} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = '' }} />
          <button className="btn btn-sm btn-danger" type="button" onClick={() => { if (confirm('Reset ALL progress? Export first if you want a backup.')) resetProgress() }}>Reset</button>
        </div>
      </section>

      <div className="grid-4" style={{ marginBottom: '1rem' }}>
        <div className="stat"><b>{Object.keys(p.lessons).length}/{LESSONS.length}</b><span>lessons</span></div>
        <div className="stat"><b>{byKind.challenge}/{totalByKind.challenge}</b><span>code challenges</span></div>
        <div className="stat"><b>{byKind.sql}/{totalByKind.sql}</b><span>SQL challenges</span></div>
        <div className="stat"><b>{byKind.quiz}/{totalByKind.quiz}</b><span>quizzes</span></div>
        <div className="stat"><b>{byKind.lab}/{totalByKind.lab}</b><span>labs</span></div>
        <div className="stat"><b>{byKind.cards}/{totalByKind.cards}</b><span>flashcard decks</span></div>
        <div className="stat"><b>{p.stats.firstTry}</b><span>first-try solves</span></div>
        <div className="stat"><b>{p.stats.runs + p.stats.sqlRuns}</b><span>test &amp; query runs</span></div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <h3>Regions</h3>
          {TRACKS.filter((t) => !t.soon).map((t) => {
            const list = LESSONS_BY_TRACK.get(t.id) || []
            const done = list.filter((l) => p.lessons[l.meta.id]).length
            return (
              <a key={t.id} href={href.track(t.id)} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 60px', gap: '0.6rem', alignItems: 'center', color: 'var(--text)', padding: '0.35rem 0', '--track': t.color } as CSSProperties}>
                <span>{t.icon}</span>
                <span><span style={{ fontSize: '0.88rem', fontWeight: 600 }}>{t.title}</span><span className="realm-progress" style={{ display: 'block', marginTop: 4 }}><i style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} /></span></span>
                <span className="ex-note" style={{ textAlign: 'right' }}>{done}/{list.length}</span>
              </a>
            )
          })}
        </div>
        <div className="panel">
          <h3>Career ladder</h3>
          <div className="ranks">
            {RANKS.map((r) => (
              <div key={r.title} className={`rank-row${rank.title === r.title ? ' on' : ''}`}>
                <span>{r.icon}</span><span style={{ flex: 1, fontWeight: rank.title === r.title ? 800 : 500 }}>{r.title}</span><span className="ex-note">level {r.level}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="section-title"><h2>🎓 Skill checks</h2><p>Best result per exam</p></div>
      <ExamGrid />

      <div className="panel" style={{ marginTop: '1rem' }}>
        <h3>Training days (last year)</h3>
        <div className="heat" style={{ gridTemplateRows: 'repeat(7, 1fr)', gridAutoFlow: 'column' }}>{heat.map((on, i) => <i key={i} className={on ? 'on' : ''} />)}</div>
      </div>

      <div className="section-title"><h2>Achievements</h2><p>{Object.keys(p.achievements).length}/{ACHIEVEMENTS.length} unlocked</p></div>
      <div className="ach-grid">
        {ACHIEVEMENTS.map((a) => {
          const got = !!p.achievements[a.id]
          return (
            <div key={a.id} className={`ach ${got ? 'unlocked' : 'locked'}`}>
              <span className="ai">{got || !a.secret ? a.icon : '❔'}</span>
              <div><b>{got || !a.secret ? a.title : 'Secret achievement'}</b><span>{got || !a.secret ? a.desc : 'Keep playing to find out.'}</span></div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
