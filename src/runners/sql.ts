// SQL challenge runner on PGlite (real PostgreSQL compiled to WASM). Shared by site + validator.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SqlResult { fields: string[]; rows: unknown[][]; rowCount: number; command?: string }
export interface SqlRun { ok: boolean; error?: string; results: SqlResult[]; ms: number }

export type PGliteCtor = new (...a: any[]) => any

export async function freshDb(PGlite: PGliteCtor, datasetSql: string, setup = ''): Promise<any> {
  const db = new PGlite()
  await db.waitReady
  if (datasetSql.trim()) await db.exec(datasetSql)
  if (setup.trim()) await db.exec(setup)
  return db
}

export async function runSql(db: any, sql: string): Promise<SqlRun> {
  const t = performance.now()
  try {
    const res: any[] = await db.exec(sql, { rowMode: 'array' })
    const results: SqlResult[] = res.map((r) => ({
      fields: (r.fields || []).map((f: any) => f.name),
      rows: r.rows || [],
      rowCount: r.affectedRows ?? (r.rows || []).length,
    }))
    return { ok: true, results, ms: performance.now() - t }
  } catch (e) {
    const err = e as any
    const where = err?.position ? ` (at character ${err.position})` : ''
    return { ok: false, error: `${err?.message ?? String(e)}${where}${err?.hint ? `\nHint: ${err.hint}` : ''}`, results: [], ms: performance.now() - t }
  }
}

/** The result we grade: the last statement that returned columns, or else the last statement. */
export function lastResult(run: SqlRun): SqlResult | undefined {
  for (let i = run.results.length - 1; i >= 0; i--) if (run.results[i].fields.length) return run.results[i]
  return run.results[run.results.length - 1]
}

export function normValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') {
    if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim())) return Math.round(Number(v) * 1e6) / 1e6
    return v
  }
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') return stableJson(v)
  return v
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`
  }
  return JSON.stringify(normValue(v))
}

export interface SqlCompare { pass: boolean; reason?: string }

export function compareResults(actual: SqlResult | undefined, expected: SqlResult | undefined, ordered: boolean): SqlCompare {
  if (!expected) return { pass: false, reason: 'No expected result (challenge bug).' }
  if (!actual) return { pass: false, reason: 'Your SQL returned no result.' }
  if (expected.fields.length && actual.fields.length !== expected.fields.length) {
    return { pass: false, reason: `Expected ${expected.fields.length} column(s) (${expected.fields.join(', ')}), got ${actual.fields.length} (${actual.fields.join(', ')}).` }
  }
  if (actual.rows.length !== expected.rows.length) {
    return { pass: false, reason: `Expected ${expected.rows.length} row(s), got ${actual.rows.length}.` }
  }
  const key = (r: unknown[]) => JSON.stringify(r.map(normValue))
  const a = actual.rows.map(key)
  const e = expected.rows.map(key)
  if (!ordered) { a.sort(); e.sort() }
  for (let i = 0; i < e.length; i++) {
    if (a[i] !== e[i]) {
      return { pass: false, reason: ordered ? `Row ${i + 1} differs (check values and ORDER BY):\n  got      ${a[i]}\n  expected ${e[i]}` : `Rows differ. First mismatch:\n  got      ${a[i]}\n  expected ${e[i]}` }
    }
  }
  return { pass: true }
}

export interface SqlChallengeSpec { db: string; setup: string; solution: string; check: string; ordered: boolean }

export type MakeDb = (seed: string, setup: string) => Promise<any>

/** Default factory: a brand-new PGlite instance per database (used by the validator). */
export const freshFactory = (PGlite: PGliteCtor): MakeDb => (seed, setup) => freshDb(PGlite, seed, setup)

/** Grade a learner's SQL. `dataset(name)` returns the seed SQL for a dataset. */
export async function gradeSql(make: MakeDb | PGliteCtor, spec: SqlChallengeSpec, userSql: string, dataset: (n: string) => string) {
  const makeDb: MakeDb = (make as any).prototype?.exec ? freshFactory(make as PGliteCtor) : (make as MakeDb)
  const seed = spec.db === 'empty' ? '' : dataset(spec.db)
  const userDb = await makeDb(seed, spec.setup)
  const user = await runSql(userDb, userSql)
  let userCheck: SqlRun | undefined
  if (user.ok && spec.check) userCheck = await runSql(userDb, spec.check)
  await userDb.close?.()

  const solDb = await makeDb(seed, spec.setup)
  const sol = await runSql(solDb, spec.solution)
  let solCheck: SqlRun | undefined
  if (sol.ok && spec.check) solCheck = await runSql(solDb, spec.check)
  await solDb.close?.()

  if (!sol.ok) return { pass: false, user, expected: undefined, reason: `Solution failed (challenge bug): ${sol.error}` }
  if (!user.ok) return { pass: false, user, expected: lastResult(solCheck || sol), reason: user.error }
  if (spec.check) {
    if (!userCheck?.ok) return { pass: false, user, expected: lastResult(solCheck!), reason: `Check query failed after your SQL: ${userCheck?.error}` }
    const cmp = compareResults(lastResult(userCheck), lastResult(solCheck!), spec.ordered)
    return { pass: cmp.pass, user, checked: lastResult(userCheck), expected: lastResult(solCheck!), reason: cmp.reason && `After your SQL, the database is not in the expected state. ${cmp.reason}` }
  }
  const cmp = compareResults(lastResult(user), lastResult(sol), spec.ordered)
  return { pass: cmp.pass, user, expected: lastResult(sol), reason: cmp.reason }
}
