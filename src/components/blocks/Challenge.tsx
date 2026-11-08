import { normalizeQuotes } from '../../engine/quotes.ts'
import { useEffect, useRef, useState } from 'react'
import type { ChallengeBlock } from '../../engine/parse.ts'
import type { Verdict } from '../../runners/execute.ts'
import { runInWorker, runInFrame } from '../../runners/client.ts'
import { useProgress, solveExercise, missExercise, revealSolution, countRun, getDraft, setDraft, clearDraft } from '../../engine/progress.ts'
import { Editor as CodeEditor } from '../Editor.tsx'
import { Markdown } from './Markdown.tsx'
import { ExerciseShell } from './ExerciseShell.tsx'

const fence = (lang: string, code: string) => '```' + lang + '\n' + code + '\n```'

export function Challenge({ b }: { b: ChallengeBlock }) {
  const p = useProgress()
  const solved = !!p.exercises[b.id]
  const [code, setCode] = useState(() => getDraft(b.id) ?? b.starter)
  const [running, setRunning] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [hints, setHints] = useState(0)
  const [showSolution, setShowSolution] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [frameH, setFrameH] = useState(120)
  const frame = useRef<HTMLIFrameElement>(null)
  const fails = verdict && !verdict.pass ? 1 : 0
  const codeRef = useRef(code)
  codeRef.current = code
  // every React run gets a FRESH sandbox iframe, so an unfinished act()/timer from a previous run can't leak
  const usedRef = useRef(false)
  const readyWaiter = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!b.react) return
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.source !== 'devquest-sandbox') return
      if (e.data.type === 'ready') {
        setFrameReady(true)
        readyWaiter.current?.()
        readyWaiter.current = null
        if (b.preview && b.mode === 'code') frame.current?.contentWindow?.postMessage({ source: 'devquest-host', type: 'preview', code: (b.setup ? b.setup + '\n' : '') + codeRef.current, preview: b.preview }, '*')
      }
      if (e.data.type === 'height') setFrameH(Math.min(520, Math.max(80, e.data.height)))
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [b.react, b.preview, b.mode, b.setup])

  const run = async () => {
    if (running) return
    setRunning(true)
    countRun('code')
    let v: Verdict
    if (b.react) {
      if (!frame.current || !frameReady) { setRunning(false); return }
      if (usedRef.current) {
        const ready = new Promise<void>((resolve) => { readyWaiter.current = resolve; setTimeout(resolve, 15000) })
        setFrameKey((k) => k + 1)
        await ready
      }
      usedRef.current = true
      if (!frame.current) { setRunning(false); return }
      v = await runInFrame(frame.current, b, normalizeQuotes(code))
      if (v.error?.startsWith('Timed out')) { setFrameReady(false); usedRef.current = false; setFrameKey((k) => k + 1) }
    } else {
      v = await runInWorker(b, normalizeQuotes(code))
    }
    setVerdict(v)
    setRunning(false)
    if (v.pass) solveExercise(b.id, b.xp, b.title)
    else missExercise(b.id)
  }

  const reset = () => { if (confirm('Reset your code to the starter?')) { setCode(b.starter); clearDraft(b.id); setVerdict(null) } }
  const onReveal = () => {
    if (!solved && !confirm('Reveal the solution? Solving after peeking gives only 25% XP.')) return
    revealSolution(b.id)
    setShowSolution(true)
  }

  const passed = verdict?.results.filter((r) => r.pass).length ?? 0
  const total = verdict?.results.length ?? 0
  const kind = b.mode === 'tests' ? 'tests' : b.react ? 'react' : 'challenge'

  return (
    <ExerciseShell id={b.id} kind={kind} cls="challenge" xp={b.xp} title={b.title}>
      <Markdown md={b.prompt} />
      {b.mode === 'tests' && (
        <>
          <p className="ex-note">Implementation under test (read-only). Your tests must pass here — and fail on {b.mutants.length} hidden buggy version{b.mutants.length > 1 ? 's' : ''}.</p>
          <Markdown md={fence(b.lang, b.impl)} />
        </>
      )}
      <div className="editor-wrap">
        <div className="editor-bar">
          <span>{b.mode === 'tests' ? 'your tests' : 'your code'} · {b.lang}</span>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={reset} type="button">Reset</button>
        </div>
        <CodeEditor value={code} lang={b.lang} onChange={(v) => { setCode(v); setDraft(b.id, v) }} onRun={run} label={`Editor for ${b.title}`} />
      </div>
      <div className="ex-actions">
        <button className="btn btn-primary" onClick={run} disabled={running || (b.react && !frameReady && !usedRef.current)} type="button">
          {running ? <><span className="spinner" /> Running…</> : b.react && !frameReady ? 'Loading sandbox…' : '▶ Run tests'}
        </button>
        <span className="ex-note kbd-hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd></span>
        <span className="spacer" />
        {b.hints.length > 0 && hints < b.hints.length && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setHints((h) => h + 1)}>💡 Hint ({hints}/{b.hints.length})</button>
        )}
        <button className="btn btn-ghost btn-sm" type="button" onClick={showSolution ? () => setShowSolution(false) : onReveal}>
          {showSolution ? 'Hide solution' : solved || fails ? '👁 Solution' : '👁 Give up?'}
        </button>
      </div>
      {b.hints.slice(0, hints).map((h, i) => <div key={i} className="hint"><b>Hint {i + 1}:</b> <Markdown md={h} inline className="" /></div>)}

      {verdict && (
        <div className="results" aria-live="polite">
          <div className={`results-head ${verdict.pass ? 'pass' : 'fail'}`}>
            {verdict.pass ? '✓ All green — nice work!' : verdict.error ? '✖ Error' : `✖ ${passed}/${total} tests passing`}
            {!verdict.pass && total > 0 && !verdict.error && <span className="ex-note" style={{ marginLeft: 'auto' }}>keep going</span>}
          </div>
          {verdict.error && <div className="test-row fail"><span className="ico">!</span><div className="test-err">{verdict.error}</div></div>}
          {verdict.results.map((r, i) => (
            <div key={i} className={`test-row ${r.pass ? 'pass' : 'fail'}`}>
              <span className="ico">{r.pass ? '✓' : '✖'}</span>
              <span>{r.name}</span>
              {!r.pass && r.error && <div className="test-err">{r.error}</div>}
            </div>
          ))}
          {verdict.mutants && (
            <div className="mutants">
              {verdict.mutants.map((m, i) => (
                <span key={i} className={`mutant ${m.caught ? 'caught' : 'alive'}`}>{m.caught ? '🧬 mutant #' + (i + 1) + ' caught' : '🧟 mutant #' + (i + 1) + ' survived'}</span>
              ))}
            </div>
          )}
          {verdict.logs.length > 0 && <div className="logs">{verdict.logs.join('\n')}</div>}
        </div>
      )}

      {b.react && (
        <div className="preview" hidden={!b.preview}>
          <div className="preview-bar">Preview{b.preview ? ` · <${b.preview} />` : ''}</div>
          <iframe key={frameKey} ref={frame} src="./sandbox.html" title={`Preview for ${b.title}`} style={{ height: frameH }} onLoad={() => { /* ready comes via postMessage */ }} />
        </div>
      )}

      {showSolution && <div style={{ marginTop: '0.8rem' }}><Markdown md={fence(b.lang, b.solution)} /></div>}
    </ExerciseShell>
  )
}
