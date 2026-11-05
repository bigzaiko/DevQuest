import { useEffect, useRef, useState } from 'react'
import { onGameEvent, rankOf, type GameEvent } from '../engine/progress.ts'
import { ACHIEVEMENT_BY_ID } from '../engine/achievements.ts'

interface Toast { id: number; e: GameEvent }
let nextId = 1

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => onGameEvent((e) => {
    if (e.type === 'level') return
    const id = nextId++
    setToasts((t) => [...t.slice(-3), { id, e }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), e.type === 'achievement' ? 5200 : 3200)
  }), [])
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(({ id, e }) => {
        if (e.type === 'xp') return (
          <div key={id} className="toast xp"><span className="ti">✨</span><div><b>+{e.amount} XP</b><span>{e.label}</span></div></div>
        )
        if (e.type === 'achievement') {
          const a = ACHIEVEMENT_BY_ID.get(e.id)
          return <div key={id} className="toast ach"><span className="ti">{a?.icon}</span><div><b>Achievement unlocked: {a?.title}</b><span>{a?.desc}</span></div></div>
        }
        return null
      })}
    </div>
  )
}

const COLORS = ['#ffc83d', '#3de8ff', '#ff4fd8', '#7cff6b', '#c07bff', '#ff8a3d']

export function LevelUp() {
  const [lv, setLv] = useState<{ level: number; rank: string } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => onGameEvent((e) => { if (e.type === 'level') setLv({ level: e.level, rank: e.rank }) }), [])
  useEffect(() => {
    if (!lv) return
    btn.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLv(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lv])
  if (!lv) return null
  const rank = rankOf(lv.level)
  const promoted = rank.level === lv.level
  return (
    <div className="modal-back" onClick={() => setLv(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="lvl-title" onClick={(e) => e.stopPropagation()}>
        <div className="confetti" aria-hidden="true">
          {Array.from({ length: 40 }, (_, i) => (
            <i key={i} style={{ left: `${(i * 37) % 100}%`, background: COLORS[i % COLORS.length], animationDelay: `${(i % 10) * 60}ms`, animationDuration: `${1400 + (i % 7) * 150}ms` }} />
          ))}
        </div>
        <div className="eyebrow">Level up!</div>
        <div className="level-badge">{lv.level}</div>
        <h2 id="lvl-title">{promoted ? `Promoted: ${rank.icon} ${rank.title}` : `You reached level ${lv.level}`}</h2>
        <p>{promoted ? 'New rank, new responsibilities. Keep going.' : `Current rank: ${rank.icon} ${rank.title}`}</p>
        <button ref={btn} className="btn btn-primary" onClick={() => setLv(null)}>Keep questing</button>
      </div>
    </div>
  )
}
