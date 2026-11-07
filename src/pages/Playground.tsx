import { normalizeQuotes } from '../engine/quotes.ts'
import { useState } from 'react'
import { DATASETS } from '../content/index.ts'
import { playSql } from '../runners/client.ts'
import type { SqlRun } from '../runners/sql.ts'
import { Editor as CodeEditor } from '../components/Editor.tsx'
import { ResultTable, SchemaView } from '../components/blocks/SqlChallenge.tsx'
import { countRun } from '../engine/progress.ts'

const EXAMPLES: Record<string, string> = {
  shop: `-- Top customers by revenue (paid + shipped orders)
SELECT c.name, c.country,
       round(sum(oi.quantity * oi.unit_price), 2) AS revenue,
       count(DISTINCT o.id)                       AS orders
FROM customers c
JOIN orders o       ON o.customer_id = c.id AND o.status IN ('paid', 'shipped')
JOIN order_items oi ON oi.order_id = o.id
GROUP BY c.id
ORDER BY revenue DESC
LIMIT 5;`,
  studio: `-- Walk the branching tree of "The Heist" with a recursive CTE
WITH RECURSIVE tree AS (
  SELECT id, title, choice_label, 0 AS depth, title::text AS path
  FROM clips WHERE project_id = 1 AND parent_clip_id IS NULL
  UNION ALL
  SELECT c.id, c.title, c.choice_label, t.depth + 1, t.path || ' → ' || c.title
  FROM clips c JOIN tree t ON c.parent_clip_id = t.id
)
SELECT repeat('   ', depth) || title AS scene, choice_label, path
FROM tree ORDER BY path;`,
  empty: `CREATE TABLE notes (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL);
INSERT INTO notes (body) VALUES ('hello'), ('postgres in the browser');
SELECT * FROM notes;`,
}

export function Playground() {
  const [db, setDb] = useState('shop')
  const [sql, setSql] = useState(EXAMPLES.shop)
  const [run, setRun] = useState<SqlRun | null>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true); countRun('sql')
    try { setRun(await playSql(db, normalizeQuotes(sql))) } catch (e) { setRun({ ok: false, error: String((e as Error).message), results: [], ms: 0 }) }
    setBusy(false)
  }
  const dbs = [...Object.keys(DATASETS), 'empty']
  return (
    <div className="page">
      <h1>🐘 SQL Playground</h1>
      <p style={{ color: 'var(--text-2)', maxWidth: '70ch' }}>
        A real PostgreSQL 18 running in your browser (PGlite / WebAssembly). Every run starts from a fresh copy of the dataset,
        so experiment freely — <code>DROP TABLE</code> away. Try <code>EXPLAIN ANALYZE</code>, window functions, jsonb, CTEs…
      </p>
      <div className="play-grid">
        <div className="panel">
          <h3>Dataset</h3>
          <select className="input" value={db} onChange={(e) => { setDb(e.target.value); setSql(EXAMPLES[e.target.value] || ''); setRun(null) }} aria-label="Dataset">
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <p className="ex-note" style={{ marginTop: '0.6rem' }}>
            <b>shop</b>: customers, products, orders, employees.<br /><b>studio</b>: a branching-video SaaS — users, projects (jsonb), clips tree, render jobs, credit ledger.
          </p>
          {db !== 'empty' && <SchemaView db={db} setup="" />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="editor-wrap" style={{ marginTop: 0 }}>
            <div className="editor-bar"><span>postgresql · {db}</span></div>
            <CodeEditor value={sql} onChange={setSql} lang="sql" onRun={go} minLines={10} label="SQL playground editor" />
          </div>
          <div className="ex-actions">
            <button className="btn btn-primary" onClick={go} disabled={busy} type="button">{busy ? <><span className="spinner" /> Running…</> : '▶ Run'}</button>
            <span className="ex-note kbd-hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd> · all statements run; every result is shown</span>
          </div>
          {run && (
            <div className="results">
              <div className={`results-head ${run.ok ? 'pass' : 'fail'}`}>{run.ok ? `✓ ${run.results.length} statement(s) · ${run.ms.toFixed(0)} ms` : '✖ PostgreSQL error'}</div>
              {!run.ok && <div className="test-row fail"><span className="ico">!</span><div className="test-err">{run.error}</div></div>}
              {run.results.map((r, i) => <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : undefined }}><ResultTable r={r} /></div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
