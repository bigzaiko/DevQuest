import { useState } from 'react'
import { href, type Route } from '../router.ts'
import { useProgress, levelOf, rankOf, streakOf } from '../engine/progress.ts'

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffc83d" /><stop offset="1" stopColor="#ff4fd8" /></linearGradient></defs>
      <rect width="64" height="64" rx="14" fill="#17133a" stroke="rgba(170,150,255,.3)" />
      <path d="M14 44 L26 20 L32 32 L38 20 L50 44" fill="none" stroke="url(#bm)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="48" r="4" fill="#3de8ff" />
    </svg>
  )
}

export function TopBar({ onSearch, route }: { onSearch: () => void; route: Route }) {
  const p = useProgress()
  const lv = levelOf(p.xp)
  const rank = rankOf(lv.level)
  const streak = streakOf(p.days)
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark')
  const toggleTheme = () => {
    const t = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = t
    localStorage.setItem('devquest:theme', t)
    setTheme(t)
  }
  const cur = (n: Route['name']) => (route.name === n ? 'page' : undefined)
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  return (
    <header className="topbar">
      <a className="brand" href={href.home()} aria-label="DevQuest home"><BrandMark /><span>Dev<b>Quest</b></span></a>
      <nav className="nav" aria-label="Main">
        <a href={href.home()} aria-current={cur('home')}>Map</a>
        <a href={href.playground()} aria-current={cur('playground')}>SQL Playground</a>
        <a href={href.profile()} aria-current={cur('profile')}>Progress</a>
      </nav>
      <div className="topbar-spacer" />
      <button className="btn btn-sm search-btn" onClick={onSearch} aria-label="Search lessons">
        <span>🔎 <span className="label">Search lessons…</span></span><kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <div className="hud">
        <span className="hud-streak" title={`${streak}-day streak`}>🔥 {streak}</span>
        <a className="hud-level" href={href.profile()} title={`Level ${lv.level} · ${rank.title}`}>
          <span className="level-badge">{lv.level}</span>
          <span className="hud-meta">
            <span className="hud-rank">{rank.icon} {rank.title}</span>
            <span className="xpbar" role="progressbar" aria-label="XP to next level" aria-valuemin={0} aria-valuemax={lv.span} aria-valuenow={lv.into}><i style={{ width: `${lv.pct * 100}%` }} /></span>
            <span className="hud-xp">{lv.into} / {lv.span} XP · {p.xp} total</span>
          </span>
        </a>
        <button className="btn btn-ghost icon-btn" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </header>
  )
}
