import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { LEVELS, type Level, type QuizBlock } from '../engine/parse.ts'
import { LESSONS, LESSONS_BY_TRACK, TRACK_BY_ID, loadLesson, type Lesson } from '../content/index.ts'
import { TRACKS } from '../content/tracks.ts'
import { useProgress, recordExam, type ExamResult } from '../engine/progress.ts'
import { href } from '../router.ts'
import { Markdown } from '../components/blocks/Markdown.tsx'

export const EXAM_SIZE = { track: 20, all: 40 }
const PER_LEVEL_SHARE: Record<Level, number> = { beginner: 0.25, intermediate: 0.3, advanced: 0.25, expert: 0.2 }
const LEVEL_LABEL: Record<Level, string> = { beginner: '🌱 Beginner', intermediate: '🌿 Intermediate', advanced: '🌳 Advanced', expert: '🐉 Expert' }
const KEYS = 'ABCDEFGH'

interface Q { quiz: QuizBlock; lesson: Lesson; level: Level }

function shuffle<T>(a: T[]): T[] {
  const r = a.slice()
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]] }
  return r
}

/** Draw questions spread over the levels (and over lessons within a level). */
function draw(pool: Q[], size: number): Q[] {
  const byLevel = new Map<Level, Q[]>(LEVELS.map((l) => [l, shuffle(pool.filter((q) => q.level === l))]))
  const out: Q[] = []
  for (const l of LEVELS) {
    const want = Math.round(size * PER_LEVEL_SHARE[l])
    const list = byLevel.get(l)!
    // round-robin across lessons so one lesson doesn't dominate
    const byLesson = new Map<string, Q[]>()
    for (const q of list) { const k = q.lesson.meta.id; if (!byLesson.has(k)) byLesson.set(k, []); byLesson.get(k)!.push(q) }
    const queues = shuffle([...byLesson.values()])
    while (out.filter((q) => q.level === l).length < want && queues.some((x) => x.length)) for (const qq of queues) { const q = qq.shift(); if (q && out.filter((x) => x.level === l).length < want) out.push(q) }
  }
  // top up from anything left if a level was short
  const rest = shuffle(pool.filter((q) => !out.includes(q)))
  while (out.length < size && rest.length) out.push(rest.shift()!)
  return out.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level))
}

export function estimateLevel(perLevel: Record<string, { right: number; total: number }>): Level | 'none' {
  let best: Level | 'none' = 'none'
  for (const l of LEVELS) {
    const s = perLevel[l]
    if (!s || !s.total) continue
    if (s.right / s.total >= 0.7) best = l
    else break
  }
  return best
}

export function Exam({ scope }: { scope: string }) {
  const p = useProgress()
  const isAll = scope === 'all'
  const track = TRACK_BY_ID.get(scope)
  const lessons = useMemo(() => (isAll ? LESSONS : LESSONS_BY_TRACK.get(scope) || []), [scope, isAll])
  const [pool, setPool] = useState<Q[] | null>(null)
  const [questions, setQuestions] = useState<Q[] | null>(null)
  const [i, setI] = useState(0)
  const [answers, setAnswers] = useState<number[][]>([])
  const [finished, setFinished] = useState<ExamResult | null>(null)
  const [startedAt, setStartedAt] = useState(0)

  useEffect(() => {
    let alive = true
    Promise.all(lessons.map((l) => loadLesson(l.meta.id).then((full) => full.exercises.filter((e): e is QuizBlock => e.kind === 'quiz').map((quiz) => ({ quiz, lesson: l, level: l.meta.level })))))
      .then((qs) => { if (alive) setPool(qs.flat()) })
    return () => { alive = false }
  }, [lessons])

  const size = isAll ? EXAM_SIZE.all : EXAM_SIZE.track
  const start = () => { setQuestions(draw(pool || [], size)); setI(0); setAnswers([]); setFinished(null); setStartedAt(Date.now()) }
  const title = isAll ? 'Final Exam — all regions' : `${track?.title} Skill Check`
  const style = { '--track': track?.color || 'var(--magenta)' } as CSSProperties
  const best = p.exams?.[scope]

  if (!isAll && !track) return <div className="page"><h1>Unknown exam</h1><a href={href.home()}>Back</a></div>

  // ── intro ──
  if (!questions) {
    return (
      <div className="page" style={style}>
        <div className="crumbs"><a href={href.home()}>Map</a><span>›</span>{track && <><a href={href.track(scope)}>{track.title}</a><span>›</span></>}<span>Skill check</span></div>
        <section className="track-hero exam-hero" style={style}>
          <span className="realm-icon" aria-hidden="true">🎓</span>
          <div style={{ flex: 1 }}>
            <div className="eyebrow">{isAll ? 'The grand trial' : track?.realm}</div>
            <h1>{title}</h1>
            <p>
              {size} random questions from {isAll ? 'every region' : 'this region'}, spread from beginner to expert. No hints and no feedback until the end —
              then you get your score per level, an estimated level, and links to the lessons worth revisiting. Take it before a region
              (placement test) or after (final check). Retake it any time; questions are drawn fresh each time.
            </p>
            <div className="track-stats">
              <span><b>{pool ? pool.length : '…'}</b> questions in the pool</span>
              <span>~<b>{Math.round(size * 0.6)}</b> min</span>
              {best && <span>Best: <b>{best.score}%</b> · {best.level === 'none' ? 'keep training' : LEVEL_LABEL[best.level as Level]}</span>}
            </div>
          </div>
          <button className="btn btn-primary" type="button" disabled={!pool || pool.length < 4} onClick={start}>{pool ? '▶ Start exam' : 'Loading…'}</button>
        </section>
        {pool && pool.length < 4 && <p>Not enough questions in this region yet.</p>}
      </div>
    )
  }

  // ── results ──
  if (finished) {
    const wrong = questions.map((q, k) => ({ q, k, a: answers[k] || [] })).filter(({ q, a }) => !isRight(q.quiz, a))
    const studyLessons = [...new Map(wrong.map(({ q }) => [q.lesson.meta.id, q.lesson])).values()]
    const verdict = finished.level === 'none' ? 'Keep training — start at the beginner lessons.' : `You are solid up to ${LEVEL_LABEL[finished.level as Level]}.`
    return (
      <div className="page" style={style}>
        <section className="finish exam-result">
          <div className="eyebrow">{title}</div>
          <div className="exam-score">{finished.score}%</div>
          <h2 style={{ margin: '0.2rem 0' }}>{finished.score >= 90 ? '🏆 Outstanding!' : finished.score >= 75 ? '🎉 Passed with honours' : finished.score >= 60 ? '✅ Passed' : '📚 Not yet — but now you know where to look'}</h2>
          <p>{finished.right}/{finished.total} correct · {Math.round(finished.seconds / 60)} min · {verdict}</p>
          <div className="level-bars">
            {LEVELS.map((l) => {
              const s = finished.perLevel[l]
              if (!s?.total) return null
              const pct = Math.round((s.right / s.total) * 100)
              return (
                <div key={l} className="level-bar">
                  <span>{LEVEL_LABEL[l]}</span>
                  <span className="realm-progress"><i style={{ width: `${pct}%`, background: pct >= 70 ? 'var(--ok)' : pct >= 40 ? 'var(--warn)' : 'var(--bad)' }} /></span>
                  <b>{s.right}/{s.total}</b>
                </div>
              )
            })}
          </div>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button className="btn btn-primary" type="button" onClick={start}>↻ Retake (new questions)</button>
            <a className="btn" href={track ? href.track(scope) : href.home()}>Back to {track ? track.title : 'the map'}</a>
          </div>
        </section>
        {studyLessons.length > 0 && (
          <>
            <div className="section-title"><h2>Study these lessons</h2><p>{studyLessons.length} lesson(s) with missed questions</p></div>
            <div className="study-list">
              {studyLessons.map((l) => (
                <a key={l.meta.id} className="node plain" href={href.lesson(l.meta.id)} style={{ '--track': TRACK_BY_ID.get(l.track)?.color } as CSSProperties}>
                  <span className="node-title">{TRACK_BY_ID.get(l.track)?.icon} {l.meta.title}</span>
                  <span className="node-sum">{l.meta.summary}</span>
                  <span className="node-meta"><span className={`chip chip-level-${l.meta.level}`}>{l.meta.level}</span></span>
                </a>
              ))}
            </div>
          </>
        )}
        {wrong.length > 0 && (
          <>
            <div className="section-title"><h2>Review your mistakes</h2></div>
            {wrong.map(({ q, k, a }) => (
              <section key={k} className="ex ex-quiz">
                <header className="ex-head"><span className="ex-kind">❓ Question {k + 1}</span><span className="ex-title" /><span className={`chip chip-level-${q.level}`}>{q.level}</span></header>
                <div className="ex-body">
                  <Markdown md={q.quiz.question} />
                  <div className="options">
                    {q.quiz.options.map((o, j) => (
                      <div key={j} className={`option${o.correct ? ' correct' : a.includes(j) ? ' wrong' : ''}`} style={{ animation: 'none' }}>
                        <span className="key">{KEYS[j]}</span><Markdown md={o.md} inline className="" />
                      </div>
                    ))}
                  </div>
                  {q.quiz.explanation && <div className="explain"><Markdown md={q.quiz.explanation} /></div>}
                  <p className="ex-note" style={{ marginTop: '0.6rem' }}>From <a href={href.lesson(q.lesson.meta.id)}>{q.lesson.meta.title}</a></p>
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    )
  }

  // ── in progress ──
  const q = questions[i]
  const sel = answers[i] || []
  const pick = (j: number) => setAnswers((prev) => {
    const next = prev.slice()
    const cur = next[i] || []
    next[i] = q.quiz.multi ? (cur.includes(j) ? cur.filter((x) => x !== j) : [...cur, j]) : [j]
    return next
  })
  const finish = () => {
    const perLevel: ExamResult['perLevel'] = {}
    let right = 0
    questions.forEach((qq, k) => {
      const ok = isRight(qq.quiz, answers[k] || [])
      if (ok) right++
      const s = (perLevel[qq.level] ||= { right: 0, total: 0 })
      s.total++
      if (ok) s.right++
    })
    const res: ExamResult = {
      score: Math.round((right / questions.length) * 100), right, total: questions.length, perLevel,
      level: estimateLevel(perLevel), seconds: Math.round((Date.now() - startedAt) / 1000), at: new Date().toISOString(),
    }
    recordExam(scope, res, title)
    setFinished(res)
    window.scrollTo({ top: 0 })
  }
  const answered = answers.filter((a) => a && a.length).length

  return (
    <div className="page exam-page" style={style}>
      <div className="exam-top">
        <span className="eyebrow">{title}</span>
        <span className="ex-note">Question {i + 1} / {questions.length} · {answered} answered</span>
      </div>
      <div className="xpbar" style={{ marginBottom: '1.2rem' }}><i style={{ width: `${((i + 1) / questions.length) * 100}%` }} /></div>
      <section className="ex ex-quiz">
        <header className="ex-head">
          <span className="ex-kind">❓ {q.quiz.multi ? 'Select all that apply' : 'Pick one'}</span>
          <span className="ex-title" />
          <span className={`chip chip-level-${q.level}`}>{q.level}</span>
        </header>
        <div className="ex-body">
          <Markdown md={q.quiz.question} />
          <div className="options" role="group" aria-label="Answers">
            {q.quiz.options.map((o, j) => (
              <button key={j} type="button" className="option" aria-pressed={sel.includes(j)} onClick={() => pick(j)}>
                <span className="key">{KEYS[j]}</span><Markdown md={o.md} inline className="" />
              </button>
            ))}
          </div>
          <div className="ex-actions">
            <button className="btn btn-sm" type="button" disabled={i === 0} onClick={() => setI(i - 1)}>← Back</button>
            <span className="spacer" />
            {i < questions.length - 1
              ? <button className="btn btn-primary" type="button" onClick={() => setI(i + 1)}>{sel.length ? 'Next →' : 'Skip →'}</button>
              : <button className="btn btn-primary" type="button" onClick={() => { if (answered < questions.length && !confirm(`${questions.length - answered} unanswered — finish anyway?`)) return; finish() }}>🏁 Finish exam</button>}
          </div>
        </div>
      </section>
      <div className="exam-dots" aria-label="Questions">
        {questions.map((_, k) => (
          <button key={k} type="button" className={`${answers[k]?.length ? 'on' : ''}${k === i ? ' cur' : ''}`} onClick={() => setI(k)} aria-label={`Question ${k + 1}`}>{k + 1}</button>
        ))}
      </div>
    </div>
  )
}

function isRight(q: QuizBlock, sel: number[]) { return q.options.every((o, j) => o.correct === sel.includes(j)) }

/** Small grid of skill checks for the home page. */
export function ExamGrid() {
  const p = useProgress()
  const items = [...TRACKS.filter((t) => !t.soon).map((t) => ({ id: t.id, icon: t.icon, title: t.title, color: t.color })), { id: 'all', icon: '👑', title: 'Final Exam', color: 'var(--magenta)' }]
  return (
    <div className="exam-grid">
      {items.map((t) => {
        const b = p.exams?.[t.id]
        return (
          <a key={t.id} className="exam-card" href={href.exam(t.id)} style={{ '--track': t.color } as CSSProperties}>
            <span className="exam-icon" aria-hidden="true">{t.icon}</span>
            <span style={{ flex: 1, minWidth: 0 }}><b>{t.title}</b><small>{b ? `Best ${b.score}% · ${b.level === 'none' ? 'keep training' : b.level}` : t.id === 'all' ? `${EXAM_SIZE.all} questions, all regions` : `${EXAM_SIZE.track} questions`}</small></span>
            <span className="exam-grade">{b ? `${b.score}%` : '🎓'}</span>
          </a>
        )
      })}
    </div>
  )
}
