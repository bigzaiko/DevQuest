import { useEffect, useMemo, useRef, useState } from 'react'
import { LESSONS, TRACK_BY_ID } from '../content/index.ts'
import { href, navigate } from '../router.ts'
import { useProgress } from '../engine/progress.ts'

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const p = useProgress()
  useEffect(() => { input.current?.focus() }, [])

  const items = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const pages = [
      { key: 'p-map', label: '🗺️ World map', sub: 'Page', to: href.home(), text: 'map home' },
      { key: 'p-play', label: '🐘 SQL Playground', sub: 'Page', to: href.playground(), text: 'sql playground postgres' },
      { key: 'p-exam', label: '🎓 Final Exam (all regions)', sub: 'Skill check', to: href.exam('all'), text: 'exam test quiz skill check final level' },
      { key: 'p-prof', label: '🏅 Progress & achievements', sub: 'Page', to: href.profile(), text: 'profile achievements export import' },
    ]
    const lessons = LESSONS.map((l) => {
      const t = TRACK_BY_ID.get(l.track)
      const headings = l.headings.join(' ')
      return {
        key: l.meta.id, label: `${t?.icon ?? ''} ${l.meta.title}`, sub: `${t?.title} · ${l.meta.level}${p.lessons[l.meta.id] ? ' · ✓' : ''}`,
        to: href.lesson(l.meta.id), text: `${l.meta.title} ${l.meta.summary} ${t?.title} ${l.meta.level} ${headings}`.toLowerCase(),
      }
    })
    const all = [...pages, ...lessons]
    if (!terms.length) return all.slice(0, 30)
    return all
      .map((x) => ({ x, score: terms.reduce((s, t) => s + (x.label.toLowerCase().includes(t) ? 3 : x.text.includes(t) ? 1 : -100), 0) }))
      .filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 30).map((r) => r.x)
  }, [q, p.lessons])

  useEffect(() => setSel(0), [q])
  const go = (to: string) => { navigate(to); onClose() }

  return (
    <div className="palette" onClick={onClose}>
      <div className="palette-box" role="dialog" aria-modal="true" aria-label="Search lessons" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lessons, topics, pages…" aria-label="Search"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[sel] ? `pal-${items[sel].key}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
            else if (e.key === 'Enter' && items[sel]) go(items[sel].to)
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox">
          {items.map((it, i) => (
            <li key={it.key} role="presentation">
              <a id={`pal-${it.key}`} role="option" aria-selected={i === sel} href={it.to} onClick={(e) => { e.preventDefault(); go(it.to) }} onMouseEnter={() => setSel(i)}>
                <span>{it.label}</span><small>{it.sub}</small>
              </a>
            </li>
          ))}
          {!items.length && <li style={{ padding: '1rem', color: 'var(--muted)' }}>Nothing found.</li>}
        </ul>
      </div>
    </div>
  )
}
