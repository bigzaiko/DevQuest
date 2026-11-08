// Main-thread API for running challenges: JS → Web Worker, React → iframe, SQL → PGlite.
import type { ChallengeBlock } from '../engine/parse.ts'
import type { Verdict, ChallengeInput } from './execute.ts'
import { gradeSql, runSql, type SqlRun } from './sql.ts'
import { DATASETS } from '../content/index.ts'

export const toInput = (c: ChallengeBlock): ChallengeInput => ({
  lang: c.lang, react: c.react, mode: c.mode, setup: c.setup, impl: c.impl, mutants: c.mutants, tests: c.tests,
})

export function runInWorker(c: ChallengeBlock, code: string, timeoutMs = 6000): Promise<Verdict> {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./jsWorker.ts', import.meta.url), { type: 'module' })
    const t = setTimeout(() => {
      w.terminate()
      resolve({ pass: false, results: [], logs: [], error: `Timed out after ${timeoutMs / 1000}s — is there an infinite loop?` })
    }, timeoutMs)
    w.onmessage = (e) => {
      clearTimeout(t); w.terminate()
      resolve(e.data.ok ? e.data.verdict : { pass: false, results: [], logs: [], error: e.data.error })
    }
    w.onerror = (e) => { clearTimeout(t); w.terminate(); resolve({ pass: false, results: [], logs: [], error: e.message }) }
    w.postMessage({ ch: toInput(c), code })
  })
}

let msgId = 0
/** Runs a React challenge inside the given sandbox iframe. */
export function runInFrame(frame: HTMLIFrameElement, c: ChallengeBlock, code: string, timeoutMs = 8000): Promise<Verdict> {
  return new Promise((resolve) => {
    const id = ++msgId
    const t = setTimeout(() => { window.removeEventListener('message', on); resolve({ pass: false, results: [], logs: [], error: `Timed out after ${timeoutMs / 1000}s — infinite loop or a render loop (setState during render)?` }) }, timeoutMs)
    const on = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.data?.source !== 'devquest-sandbox' || e.data.type !== 'result' || e.data.id !== id) return
      clearTimeout(t); window.removeEventListener('message', on)
      resolve(e.data.verdict)
    }
    window.addEventListener('message', on)
    frame.contentWindow?.postMessage({ source: 'devquest-host', type: 'run', id, ch: toInput(c), code, preview: c.preview }, '*')
  })
}

// ───────────── SQL: one shared PGlite instance, reset between runs ─────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dbPromise: Promise<any> | null = null
let chain: Promise<unknown> = Promise.resolve()

async function getDb() {
  if (!dbPromise) {
    dbPromise = import('@electric-sql/pglite').then(async ({ PGlite }) => {
      const db = new PGlite()
      await db.waitReady
      return db
    })
  }
  return dbPromise
}

/** Warm up Postgres in the background (called when a lesson with SQL opens). */
export function preloadPostgres() { getDb().catch(() => { dbPromise = null }) }

async function resetDb(seed: string, setup: string) {
  const db = await getDb()
  try { await db.exec('ROLLBACK') } catch { /* no tx */ }
  // session-level leftovers: temp objects (pg_temp functions/tables), prepared statements, SET ROLE,
  // settings, advisory locks, LISTEN — DISCARD ALL clears all of them (must run outside a transaction)
  try { await db.exec('DISCARD ALL') } catch { /* ignore */ }
  await db.exec(`RESET ALL; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC; SET search_path TO "$user", public;`)
  // roles are cluster-wide and survive the schema drop
  const roles = await db.query(`SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' AND rolname <> current_user`)
  for (const r of roles.rows as { rolname: string }[]) {
    try { await db.exec(`DROP OWNED BY "${r.rolname}" CASCADE; DROP ROLE IF EXISTS "${r.rolname}"`) } catch { /* ignore */ }
  }
  // drop any extra schemas the learner created
  const extra = await db.query(`SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'`)
  for (const r of extra.rows as { nspname: string }[]) await db.exec(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`)
  if (seed.trim()) await db.exec(seed)
  if (setup.trim()) await db.exec(setup)
  // hand out a view without close(): the instance is shared and reused across runs
  return { exec: db.exec.bind(db), query: db.query.bind(db) }
}

function serial<T>(f: () => Promise<T>): Promise<T> {
  const p = chain.then(f, f)
  chain = p.catch(() => undefined)
  return p
}

export const dataset = (n: string) => {
  if (!(n in DATASETS)) throw new Error(`Unknown dataset "${n}"`)
  return DATASETS[n]
}

export function gradeSqlChallenge(spec: { db: string; setup: string; solution: string; check: string; ordered: boolean }, userSql: string) {
  return serial(() => gradeSql((seed, setup) => resetDb(seed, setup), spec, userSql, dataset))
}

/** Free-form playground run. */
export function playSql(db: string, sql: string): Promise<SqlRun> {
  return serial(async () => {
    const inst = await resetDb(db === 'empty' ? '' : dataset(db), '')
    return runSql(inst, sql)
  })
}

export interface TableInfo { name: string; columns: { name: string; type: string; pk: boolean; fk?: string }[] }
const schemaCache = new Map<string, TableInfo[]>()
export function datasetSchema(db: string, setup = ''): Promise<TableInfo[]> {
  const key = db + '\n' + setup
  const hit = schemaCache.get(key)
  if (hit) return Promise.resolve(hit)
  return serial(async () => {
    const inst = await resetDb(db === 'empty' ? '' : dataset(db), setup)
    const cols = await inst.query(`
      SELECT c.table_name, c.column_name, c.data_type, c.ordinal_position,
        EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k
                ON tc.constraint_name = k.constraint_name AND tc.table_name = k.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY' AND k.table_name = c.table_name AND k.column_name = c.column_name) AS pk,
        (SELECT ccu.table_name || '.' || ccu.column_name FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage k ON tc.constraint_name = k.constraint_name AND tc.table_name = k.table_name
           JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY' AND k.table_name = c.table_name AND k.column_name = c.column_name LIMIT 1) AS fk
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`)
    const map = new Map<string, TableInfo>()
    for (const r of cols.rows as { table_name: string; column_name: string; data_type: string; pk: boolean; fk: string | null }[]) {
      if (!map.has(r.table_name)) map.set(r.table_name, { name: r.table_name, columns: [] })
      map.get(r.table_name)!.columns.push({ name: r.column_name, type: r.data_type, pk: r.pk, fk: r.fk || undefined })
    }
    const out = [...map.values()]
    schemaCache.set(key, out)
    return out
  })
}
