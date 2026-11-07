import { normalizeQuotes } from '../../engine/quotes.ts'
import { useEffect, useState } from 'react'
import type { SqlBlock } from '../../engine/parse.ts'
import type { SqlResult, SqlRun } from '../../runners/sql.ts'
import { gradeSqlChallenge, datasetSchema, type TableInfo } from '../../runners/client.ts'
import { useProgress, solveExercise, missExercise, revealSolution, countRun, getDraft, setDraft, clearDraft } from '../../engine/progress.ts'
import { Editor as CodeEditor } from '../Editor.tsx'
import { Markdown } from './Markdown.tsx'
import { ExerciseShell } from './ExerciseShell.tsx'

export function ResultTable({ r, max = 200 }: { r: SqlResult; max?: number }) {
  if (!r.fields.length) return <div className="result-meta">OK — {r.rowCount} row(s) affected.</div>
  return (
    <>
      <div className="result-table">
        <table>
          <thead><tr>{r.fields.map((f, i) => <th key={i}>{f}</th>)}</tr></thead>
          <tbody>
            {r.rows.slice(0, max).map((row, i) => (
              <tr key={i}>{(row as unknown[]).map((v, j) => <td key={j} className={v === null ? 'null' : ''}>{fmtCell(v)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="result-meta">{r.rows.length} row(s){r.rows.length > max ? ` · showing first ${max}` : ''}</div>
    </>
  )
}

export function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.000Z$/, 'Z')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function SchemaView({ db, setup }: { db: string; setup: string }) {
  const [tables, setTables] = useState<TableInfo[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { datasetSchema(db, setup).then(setTables, (e) => setErr(String(e?.message ?? e))) }, [db, setup])
  if (err) return <p className="ex-note">Schema unavailable: {err}</p>
  if (!tables) return <div className="booting"><span className="spinner" /> Booting PostgreSQL (WASM)…</div>
  if (!tables.length) return null
  return (
    <div className="schema" aria-label="Database schema">
      {tables.map((t) => (
        <details key={t.name} className="schema-table">
          <summary>📋 {t.name}</summary>
          <div className="schema-cols">
            {t.columns.map((c) => (
              <span key={c.name} className={c.pk ? 'pk' : ''} title={c.fk ? `→ ${c.fk}` : undefined}>
                {c.pk ? '🔑 ' : c.fk ? '🔗 ' : ''}{c.name} <i>{c.type}</i>
              </span>
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}

interface Grade { pass: boolean; user: SqlRun; expected?: SqlResult; checked?: SqlResult; reason?: string }

export function SqlChallenge({ b }: { b: SqlBlock }) {
  const p = useProgress()
  const solved = !!p.exercises[b.id]
  const [code, setCode] = useState(() => getDraft(b.id) ?? b.starter)
  const [running, setRunning] = useState(false)
  const [grade, setGrade] = useState<Grade | null>(null)
  const [showExpected, setShowExpected] = useState(false)
  const [hints, setHints] = useState(0)
  const [showSolution, setShowSolution] = useState(false)

  const run = async () => {
    if (running || !code.trim()) return
    setRunning(true)
    countRun('sql')
    try {
      const g = (await gradeSqlChallenge(b, normalizeQuotes(code))) as Grade
      setGrade(g)
      if (g.pass) solveExercise(b.id, b.xp, b.title)
      else missExercise(b.id)
    } catch (e) {
      setGrade({ pass: false, user: { ok: false, error: String((e as Error)?.message ?? e), results: [], ms: 0 } })
    }
    setRunning(false)
  }

  const userLast = grade?.user.results.filter((r) => r.fields.length).at(-1) ?? grade?.user.results.at(-1)
  const onReveal = () => {
    if (!solved && !confirm('Reveal the solution? Solving after peeking gives only 25% XP.')) return
    revealSolution(b.id)
    setShowSolution(true)
  }

  return (
    <ExerciseShell id={b.id} kind="sql" cls="sql" xp={b.xp} title={b.title}>
      <Markdown md={b.prompt} />
      <SchemaView db={b.db} setup={b.setup} />
      <div className="editor-wrap">
        <div className="editor-bar">
          <span>postgresql · db: {b.db}{b.ordered ? ' · row order matters' : ''}</span>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setCode(b.starter); clearDraft(b.id); setGrade(null) }}>Reset</button>
        </div>
        <CodeEditor value={code} lang="sql" onChange={(v) => { setCode(v); setDraft(b.id, v) }} onRun={run} minLines={4} label={`SQL editor for ${b.title}`} />
      </div>
      <div className="ex-actions">
        <button className="btn btn-primary" onClick={run} disabled={running} type="button">
          {running ? <><span className="spinner" /> Running…</> : '▶ Run query'}
        </button>
        <span className="ex-note kbd-hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd></span>
        <span className="spacer" />
        {b.hints.length > 0 && hints < b.hints.length && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setHints((h) => h + 1)}>💡 Hint ({hints}/{b.hints.length})</button>
        )}
        <button className="btn btn-ghost btn-sm" type="button" onClick={showSolution ? () => setShowSolution(false) : onReveal}>
          {showSolution ? 'Hide solution' : '👁 Solution'}
        </button>
      </div>
      {b.hints.slice(0, hints).map((h, i) => <div key={i} className="hint"><b>Hint {i + 1}:</b> <Markdown md={h} inline className="" /></div>)}

      {grade && (
        <div className="results" aria-live="polite">
          <div className={`results-head ${grade.pass ? 'pass' : 'fail'}`}>
            {grade.pass ? '✓ Correct result!' : grade.user.ok ? '✖ Not the expected result' : '✖ PostgreSQL error'}
            {grade.user.ok && <span className="ex-note" style={{ marginLeft: 'auto' }}>{grade.user.ms.toFixed(0)} ms</span>}
          </div>
          {!grade.pass && (grade.reason || grade.user.error) && <div className="test-row fail"><span className="ico">!</span><div className="test-err">{grade.reason || grade.user.error}</div></div>}
          {grade.checked && <><div className="result-meta">Check query after your SQL:</div><ResultTable r={grade.checked} /></>}
          {!grade.checked && userLast && <ResultTable r={userLast} />}
          {!grade.pass && grade.expected && (
            <div style={{ borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" style={{ margin: '0.4rem' }} type="button" onClick={() => setShowExpected((s) => !s)}>
                {showExpected ? 'Hide' : 'Show'} expected result
              </button>
              {showExpected && <ResultTable r={grade.expected} />}
            </div>
          )}
        </div>
      )}
      {showSolution && <div style={{ marginTop: '0.8rem' }}><Markdown md={'```sql\n' + b.solution + '\n```'} /></div>}
    </ExerciseShell>
  )
}
