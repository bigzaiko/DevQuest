import { useEffect, useState } from 'react'
import { useRoute } from './router.ts'
import { TopBar } from './components/TopBar.tsx'
import { Toasts, LevelUp } from './components/Toasts.tsx'
import { CommandPalette } from './components/CommandPalette.tsx'
import { Home } from './pages/Home.tsx'
import { TrackPage } from './pages/TrackPage.tsx'
import { LessonPage } from './pages/LessonPage.tsx'
import { Profile } from './pages/Profile.tsx'
import { Playground } from './pages/Playground.tsx'
import { Exam } from './pages/Exam.tsx'

export function App() {
  const route = useRoute()
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  let page
  switch (route.name) {
    case 'home': page = <Home />; break
    case 'track': page = <TrackPage id={route.id} />; break
    case 'lesson': page = <LessonPage key={route.id} id={route.id} />; break
    case 'profile': page = <Profile />; break
    case 'playground': page = <Playground />; break
    case 'exam': page = <Exam key={route.id} scope={route.id} />; break
    default: page = <div className="page"><h1>Lost in the fog</h1><p>This path doesn't exist. <a href="#/">Back to the map</a>.</p></div>
  }

  return (
    <>
      <a href="#main" className="sr-only" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus() }}>Skip to content</a>
      <TopBar onSearch={() => setPaletteOpen(true)} route={route} />
      <main id="main" tabIndex={-1}>{page}</main>
      <footer className="footer">
        DevQuest — a full-stack training ground · progress is stored in your browser ·{' '}
        <a href="https://github.com/bigzaiko/DevQuest" target="_blank" rel="noreferrer">source on GitHub</a>
      </footer>
      <nav className="mobile-nav" aria-label="Mobile">
        <a href="#/" aria-current={route.name === 'home' || route.name === 'track' ? 'page' : undefined}><span aria-hidden="true">🗺️</span>Map</a>
        <button type="button" onClick={() => setPaletteOpen(true)}><span aria-hidden="true">🔎</span>Search</button>
        <a href="#/playground" aria-current={route.name === 'playground' ? 'page' : undefined}><span aria-hidden="true">🐘</span>SQL</a>
        <a href="#/profile" aria-current={route.name === 'profile' ? 'page' : undefined}><span aria-hidden="true">🏅</span>Progress</a>
      </nav>
      <Toasts />
      <LevelUp />
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  )
}
