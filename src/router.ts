// Tiny hash router — hash URLs work on GitHub Pages without any 404 tricks.
import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'track'; id: string }
  | { name: 'lesson'; id: string }
  | { name: 'profile' }
  | { name: 'playground' }
  | { name: 'exam'; id: string }
  | { name: 'notfound' }

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').split('?')[0]
  const [a, b] = h.split('/')
  if (!a) return { name: 'home' }
  if (a === 'track' && b) return { name: 'track', id: b }
  if (a === 'lesson' && b) return { name: 'lesson', id: b }
  if (a === 'profile') return { name: 'profile' }
  if (a === 'playground') return { name: 'playground' }
  if (a === 'exam' && b) return { name: 'exam', id: b }
  return { name: 'notfound' }
}

let current = parse(location.hash)
const subs = new Set<() => void>()
window.addEventListener('hashchange', () => {
  current = parse(location.hash)
  subs.forEach((s) => s())
  // scroll to an in-page anchor (#/lesson/x?a=section) or to the top
  const anchor = new URLSearchParams(location.hash.split('?')[1] || '').get('a')
  if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  else window.scrollTo({ top: 0 })
})

export function useRoute(): Route {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb) }, () => current)
}

export const href = {
  home: () => '#/',
  track: (id: string) => `#/track/${id}`,
  lesson: (id: string, anchor?: string) => `#/lesson/${id}${anchor ? `?a=${anchor}` : ''}`,
  profile: () => '#/profile',
  playground: () => '#/playground',
  exam: (id: string) => `#/exam/${id}`,
}

export function navigate(h: string) { location.hash = h.replace(/^#/, '') }
