// Browser self-test hook (only loaded with ?selftest in the URL). Used by scripts/selftest.ts to run
// every challenge through the REAL production runners: Web Worker, React iframe sandbox, PGlite.
import { LESSONS, loadLesson } from './content/index.ts'
import type { ChallengeBlock, SqlBlock } from './engine/parse.ts'
import { runInWorker, runInFrame, gradeSqlChallenge } from './runners/client.ts'

let frame: HTMLIFrameElement | null = null
function newFrame(): Promise<HTMLIFrameElement> {
  frame?.remove()
  const f = document.createElement('iframe')
  f.src = './sandbox.html'
  f.style.cssText = 'position:fixed;left:-9999px;width:800px;height:600px'
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sandbox did not become ready')), 15000)
    const on = (e: MessageEvent) => {
      if (e.source === f.contentWindow && e.data?.source === 'devquest-sandbox' && e.data.type === 'ready') {
        clearTimeout(t); window.removeEventListener('message', on); frame = f; resolve(f)
      }
    }
    window.addEventListener('message', on)
    document.body.appendChild(f)
  })
}

async function runCode(ch: ChallengeBlock, code: string) {
  if (!ch.react) return runInWorker(ch, code)
  // same as the real UI: a fresh sandbox per run
  const f = await newFrame()
  return runInFrame(f, ch, code)
}

export interface Failure { lesson: string; id: string; problem: string }

async function testLesson(id: string): Promise<{ checked: number; failures: Failure[] }> {
  const failures: Failure[] = []
  let checked = 0
  const l = await loadLesson(id)
  for (const e of l.exercises) {
    if (e.kind === 'challenge') {
      const ch = e as ChallengeBlock
      checked++
      const sol = await runCode(ch, ch.solution)
      if (!sol.pass) failures.push({ lesson: id, id: ch.id, problem: `solution fails in browser: ${sol.error ?? ''} ${sol.results.filter((r) => !r.pass).map((r) => `${r.name}: ${r.error}`).join(' | ')}`.slice(0, 600) })
      if (ch.starter) {
        const st = await runCode(ch, ch.starter)
        if (st.pass) failures.push({ lesson: id, id: ch.id, problem: 'starter already passes in browser' })
      }
    } else if (e.kind === 'sql') {
      const s = e as SqlBlock
      checked++
      const g = await gradeSqlChallenge(s, s.solution)
      if (!g.pass) failures.push({ lesson: id, id: s.id, problem: `SQL solution fails in browser: ${g.reason}`.slice(0, 600) })
      if (s.starter) {
        const st = await gradeSqlChallenge(s, s.starter)
        if (st.pass) failures.push({ lesson: id, id: s.id, problem: 'SQL starter already passes in browser' })
      }
    }
  }
  return { checked, failures }
}

;(window as unknown as Record<string, unknown>).__devquestSelfTest = {
  lessons: () => LESSONS.map((l) => l.meta.id),
  testLesson,
}
