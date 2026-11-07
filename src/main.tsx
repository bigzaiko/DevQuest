import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App.tsx'

// After a new deploy, an already-open tab still references the previous build's hashed chunks,
// which no longer exist on GitHub Pages. Reload once to pick up the new build.
function reloadForNewBuild() {
  try {
    const last = Number(sessionStorage.getItem('devquest:reloaded') || 0)
    if (Date.now() - last < 30_000) return false
    sessionStorage.setItem('devquest:reloaded', String(Date.now()))
  } catch { /* storage blocked */ }
  location.reload()
  return true
}
window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); reloadForNewBuild() })

if (new URLSearchParams(location.search).has('selftest')) import('./selftest.ts')

const theme = localStorage.getItem('devquest:theme')
if (theme) document.documentElement.dataset.theme = theme

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
