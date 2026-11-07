---
id: cap-11
title: v2 Without Downtime
level: expert
minutes: 420
xp: 250
summary: Change the live BranchStory system safely — a schemaVersion and scene tags in the jsonb document, upcasters on read, a paced backfill on the cap-08 worker, expand → deploy → contract migrations, a dark-launched UI behind a feature flag, and a rolling deploy on kind with a rollback plan for every stage.
---

Version 1.0 from **Ship It** is the last release you will ever ship to an empty database. From now
on, every change lands on **live data** (thousands of stories saved in the old shape) and meets
**running code that doesn't know about it yet**: old API pods in the middle of a rollout, old SPA
tabs that nobody reloaded since last week, and a worker that was built before the change.

This lesson ships one small feature, **scene tags** (`"intro"`, `"combat"`, `"ending"` on each
scene), and uses it to practise the routine that real teams follow for every change to a live system:

1. Teach the document to say which **shape** it has (`schemaVersion`), and upgrade old shapes on read.
2. **Expand** the database schema in a way the old code doesn't notice.
3. **Deploy** new code that reads old and new data, with the UI hidden behind a **feature flag**.
4. **Backfill** old rows in the background, slowly, with the cap-08 worker.
5. **Contract**: remove the old path once nothing uses it any more.
6. At every step, know exactly how to **roll back**, and when you no longer can.

Nothing in it is specific to tags. Swap "tags" for "a currency field on invoices" or "a new
address format" and the steps stay the same.

:::info title="Words you'll meet in this lesson"
- **Zero downtime**: users keep working during the change. No maintenance page, no failed requests.
- **Rolling update**: Kubernetes replaces pods a few at a time, so old and new versions serve traffic **together** for a while.
- **Mixed-version window**: that "together" period. Every change has to be correct inside it.
- **Schema**: two meanings here. The *database schema* is tables and columns. The *document schema* is the JSON shape inside `projects.doc`.
- **Backward compatible**: new code still works with old data and old clients.
- **Forward compatible**: old code still works with data written by new code.
:::

## The mixed-version window

Here is what a rolling update of BranchStory 1.0 → 1.1 really looks like from the database's
point of view. Time runs downwards:

```text
            api pods              worker pods         browsers                       database schema
 t0   [1.0] [1.0]              [1.0] [1.0]        tabs running SPA 1.0           1.0
 t1   migrator init container of the first 1.1 pod runs the expand migration ──▶ 1.1 (new nullable column)
 t2   [1.0] [1.0] [1.1]        [1.0] [1.0]        1.0 tabs talk to 1.0 AND 1.1 pods
 t3   [1.0] [1.1] [1.1]        [1.1] [1.0]        some tabs reload and get SPA 1.1
 t4   [1.1] [1.1]              [1.1] [1.1]        a 1.0 tab from last Friday is still open
 t5   … the flag goes on, the backfill runs, days pass …
 t6   release 1.2: contract migration                                              1.2
```

Read it column by column and list every pair that meets:

- **Old code + new schema** (t1–t3): 1.0 pods run against a table that already has the new
  column. That only works if the migration is *additive*.
- **New code + old data** (t2 onwards, for days): 1.1 reads documents that were saved by 1.0 and
  have no `schemaVersion`.
- **Old code + new data** (t2–t4): a 1.0 pod or a 1.0 browser tab loads a document that 1.1 saved,
  with fields it has never heard of. If it drops those fields on its next save, data is lost
  silently.
- **New code + old schema**: never, *if* migrations run before new code starts (cap-10's migrator
  init container guarantees that), and *if* the new code refuses to serve before its migration is
  there (you'll add a readiness check for that in Lab 4).

:::quiz id=cap-11-q1 xp=15
During the 1.0 → 1.1 rolling update, which combinations can **actually occur**? Select all that apply.
- [x] An API 1.0 pod serving requests while the expand migration of 1.1 has already been applied
- [x] An SPA 1.0 tab saving a document through an API 1.1 pod
- [x] An API 1.1 pod reading a document that was last saved by 1.0
- [ ] An API 1.1 pod serving requests before the 1.1 migrations ran
> The migrator init container runs **before** the first 1.1 API container starts, so new code never meets the old schema (and Lab 4 adds a readiness check that would hold it back if it did). Everything else happens all the time: old pods keep serving during the rollout, so the migration must be invisible to them. Old browser tabs live for days, so 1.1 must accept their saves. Old documents stay in the table until a backfill rewrites them, so 1.1 must read them. Designing for these combinations is the whole job.
:::

## Versioning the document

`projects.doc` is one jsonb value per story (cap-02 chose that so a save is one compare-and-swap).
Its shape has never changed, so nothing in it says which shape it is. That has to change *before*
the first change, because the reader needs to know which upgrade steps to run.

**`schemaVersion`** is an integer at the top of the document that names its shape. It is not the
same as `projects.version` from cap-04:

| | `projects.version` (cap-04) | `doc.schemaVersion` (this lesson) |
|---|---|---|
| Counts | saves of *this* story | shapes of the document *format* |
| Changes when | anybody saves | a release changes the format |
| Used for | refusing stale writes (409 / 412) | knowing which upgrade steps to run |
| Typical value | 1 … thousands | 1, 2, 3 |

The format history of BranchStory documents:

```json
// v1 (cap-02 … cap-10): no schemaVersion; old editor builds sometimes left fields out
{ "startNodeId": "a",
  "nodes": [{ "id": "a", "title": "Gate", "x": 10, "y": 20 }],
  "edges": [{ "id": "e1", "from": "a", "to": "a" }] }

// v2: every field is present, so readers no longer need "?? default" everywhere
{ "schemaVersion": 2, "startNodeId": "a",
  "nodes": [{ "id": "a", "title": "Gate", "text": "", "mediaUrl": null, "x": 10, "y": 20 }],
  "edges": [{ "id": "e1", "from": "a", "to": "a", "label": "" }] }

// v3: scenes have tags
{ "schemaVersion": 3, "startNodeId": "a",
  "nodes": [{ "id": "a", "title": "Gate", "text": "", "mediaUrl": null, "x": 10, "y": 20, "tags": ["intro"] }],
  "edges": [{ "id": "e1", "from": "a", "to": "a", "label": "" }] }
```

Remember the defensive reader in cap-08's `PlayerBuilder` (`string? Title`, `List<StoryNode>? Nodes`)?
That was v1's missing fields leaking into every consumer. v2 fixes it once, at the source.

**A missing `schemaVersion` means 1**, never "current". The only documents without the field are
the ones written before the field existed. If missing meant "current", the reader would skip the
upgrade steps for exactly the documents that need them.

:::quiz id=cap-11-q2 xp=15
A teammate writes the reader as `var from = doc.schemaVersion ?? StoryDoc.CurrentSchemaVersion;`.
What breaks?
- [ ] Nothing: new documents always have the field, and old ones are upgraded by the backfill anyway
- [x] Every v1 document is treated as v3, so no upgrade step runs and readers get scenes without `tags` and edges without `label`
- [ ] Only documents with a `schemaVersion` larger than the current one are affected
- [ ] The database rejects the save because the column is NOT NULL
> A missing field is information: "written before versioning existed", which is version 1. Defaulting to *current* silently skips every step for exactly the documents that need them, and the backfill doesn't save you, because it uses the same reader to decide what to do. The NOT NULL option confuses the document with the table: nothing in Postgres looks inside the jsonb value.
:::

## Upcasters: migrate on read

An **upcaster** is a function that turns a document of version *n* into version *n + 1*. Chain
them and any stored document can be brought up to the current version at the moment it is read:

```text
 stored v1 ──V1ToV2──▶ v2 ──V2ToV3──▶ v3 ──▶ the C# record / the TypeScript type
 stored v2 ─────────────▶ v2 ──V2ToV3──▶ v3
 stored v3 ─────────────────────────────▶ v3     (no step runs)
```

Why on read, and not with one big `UPDATE` at deploy time?

- **No big-bang.** Rewriting a million rows in a deploy step takes minutes, holds locks, and
  blocks the rollout. Reading lazily costs microseconds per document.
- **Old data stays readable forever.** A backup restored next year, a document that the backfill
  skipped because it failed, a row an old pod saved after the backfill passed it: all still work.
- **The upgrade lives in code**, next to the types it produces, with unit tests.

The backfill (later in this lesson) still rewrites old rows, but only so that you can eventually
**contract**: rely on the new shape in SQL, add a constraint, and delete old steps. The upcaster is
what makes the system correct; the backfill only makes it tidy.

Four rules make upcasters safe in a mixed-version world:

1. **Idempotent.** Running the chain on its own output changes nothing. *Idempotent* means "doing
   it twice has the same effect as doing it once", the property cap-08 demanded from job handlers.
2. **Keep what you don't know.** A step adds or fixes the fields it owns and copies everything else
   through. This is the **tolerant reader** pattern: be strict about what you need, lenient about the rest.
3. **Never downgrade.** A document with a *higher* version than the code knows comes from a newer
   release (think: you rolled back). Refuse to rewrite it. Throwing is better than saving it in
   an older shape and losing the new fields.
4. **Pure.** No database, no clock, no randomness: just JSON in, JSON out. That makes them trivial
   to test and safe to run anywhere: API, worker, browser.

A tiny example of rule 2 in TypeScript, the difference between losing data and keeping it:

```ts
// ❌ rebuilds the node from known fields: an unknown "color" (or next year's field) is gone
const bad = (n: any) => ({ id: n.id, title: n.title ?? '', tags: n.tags ?? [] })
// ✅ spreads the original, then fixes what this step owns
const good = (n: any) => ({ ...n, tags: Array.isArray(n.tags) ? n.tags : [] })
```

Rule 1 has a non-obvious case, and it is the reason the upcaster must be idempotent and not just
correct. cap-05's `normalizeDoc` rebuilds the document object from three known fields, so an
**old SPA tab drops `schemaVersion`** but keeps the node objects (with their `tags`) as they were.
Its next save arrives looking like v1 while it actually contains v3 data. The chain runs v1→v2 and
v2→v3 on it again, and because each step only *fills in what's missing*, the tags survive.

:::challenge id=cap-11-c1 lang=ts xp=60
title: An idempotent upcaster chain (v1 → v3)
Implement `upcast(doc)`, which returns the document in schema version `CURRENT` (3).

- The version is `doc.schemaVersion`; a **missing** field means version 1. Anything that is not
  an integer ≥ 1 throws. A version **greater than `CURRENT`** throws an error whose message
  contains `newer` (never downgrade).
- **v1 → v2**: `startNodeId` missing → `null`; `nodes` / `edges` missing → `[]`; on every node,
  missing (or `null`) `title` / `text` → `''`, `mediaUrl` → `null`, `x` / `y` → `0`; on every edge, missing
  (or `null`) `label` → `''`. Existing values are kept.
- **v2 → v3**: every node whose `tags` is not an array gets `tags: []`. Existing tags are kept.
- Set `schemaVersion` to the version each step produces.
- **Keep unknown fields** on the document, nodes and edges. **Never mutate** the input.
- Upcasting a current document returns an equal document, so `upcast(upcast(d))` equals `upcast(d)`.

hint: Keep the steps in a table: `const steps: Record<number, (d) => Doc> = { 1: v1ToV2, 2: v2ToV3 }`, then loop `for (let v = from; v < CURRENT; v++) d = steps[v](d)`.
hint: `{ ...n, title: n.title ?? '' }` copies the node (no mutation) and keeps unknown fields at the same time.
hint: `doc.schemaVersion ?? 1`, then `Number.isInteger(from) && from >= 1`.

```ts starter
type Doc = Record<string, any>

export const CURRENT = 3

export function upcast(doc: Doc): Doc {
  // TODO: read the version (missing = 1), refuse invalid or newer documents,
  // then run v1 → v2 and v2 → v3 without mutating `doc`.
  return { ...doc, schemaVersion: CURRENT }
}
```

```ts solution
type Doc = Record<string, any>

export const CURRENT = 3

function v1ToV2(d: Doc): Doc {
  const nodes: Doc[] = Array.isArray(d.nodes) ? d.nodes : []
  const edges: Doc[] = Array.isArray(d.edges) ? d.edges : []
  return {
    ...d,
    schemaVersion: 2,
    startNodeId: d.startNodeId ?? null,
    nodes: nodes.map((n) => ({
      ...n,
      title: n.title ?? '',
      text: n.text ?? '',
      mediaUrl: n.mediaUrl ?? null,
      x: n.x ?? 0,
      y: n.y ?? 0,
    })),
    edges: edges.map((e) => ({ ...e, label: e.label ?? '' })),
  }
}

function v2ToV3(d: Doc): Doc {
  const nodes: Doc[] = Array.isArray(d.nodes) ? d.nodes : []
  return {
    ...d,
    schemaVersion: 3,
    nodes: nodes.map((n) => (Array.isArray(n.tags) ? n : { ...n, tags: [] })),
  }
}

const steps: Record<number, (d: Doc) => Doc> = { 1: v1ToV2, 2: v2ToV3 }

export function upcast(doc: Doc): Doc {
  const from = doc.schemaVersion ?? 1
  if (!Number.isInteger(from) || from < 1) throw new Error(`invalid schemaVersion: ${String(from)}`)
  if (from > CURRENT) throw new Error(`schemaVersion ${from} is newer than this build understands (${CURRENT})`)
  let d = doc
  for (let v = from; v < CURRENT; v++) d = steps[v](d)
  return d
}
```

```ts tests
const legacy = () => ({
  startNodeId: 'a',
  nodes: [
    { id: 'a', title: 'Gate', text: 'A gate.', x: 10, y: 20 },
    { id: 'b', text: 'Inside.' },
  ],
  edges: [{ id: 'e1', from: 'a', to: 'b' }],
})

test('v1 becomes a complete v3 document', () => {
  expect(upcast(legacy())).toEqual({
    schemaVersion: 3,
    startNodeId: 'a',
    nodes: [
      { id: 'a', title: 'Gate', text: 'A gate.', mediaUrl: null, x: 10, y: 20, tags: [] },
      { id: 'b', title: '', text: 'Inside.', mediaUrl: null, x: 0, y: 0, tags: [] },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', label: '' }],
  })
})

test('missing arrays and start become empty values', () => {
  expect(upcast({})).toEqual({ schemaVersion: 3, startNodeId: null, nodes: [], edges: [] })
})

test('a v2 document only gets tags', () => {
  const v2 = { schemaVersion: 2, startNodeId: null, nodes: [{ id: 'a', title: '', text: '', mediaUrl: null, x: 0, y: 0 }], edges: [] }
  expect(upcast(v2).nodes[0]).toEqual({ id: 'a', title: '', text: '', mediaUrl: null, x: 0, y: 0, tags: [] })
  expect(upcast(v2).schemaVersion).toBe(3)
})

test('does not mutate its input', () => {
  const input = legacy()
  const before = JSON.stringify(input)
  upcast(input)
  expect(JSON.stringify(input)).toBe(before)
})

test('is idempotent', () => {
  const once = upcast(legacy())
  expect(upcast(once)).toEqual(once)
  expect(upcast(upcast(once))).toEqual(once)
})

test('a current document comes back unchanged, tags included', () => {
  const v3 = { schemaVersion: 3, startNodeId: 'a', nodes: [{ id: 'a', title: 'A', text: '', mediaUrl: null, x: 0, y: 0, tags: ['intro', 'boss'] }], edges: [] }
  expect(upcast(v3)).toEqual(v3)
})

test('tags survive a document that lost its schemaVersion label', () => {
  const relabeled = { startNodeId: 'a', nodes: [{ id: 'a', title: 'A', text: '', mediaUrl: null, x: 0, y: 0, tags: ['intro'] }], edges: [] }
  expect(upcast(relabeled).nodes[0].tags).toEqual(['intro'])
})

test('unknown fields are kept everywhere', () => {
  const doc = { theme: 'dark', startNodeId: null, nodes: [{ id: 'a', color: 'red' }], edges: [{ id: 'e', from: 'a', to: 'a', weight: 2 }] }
  const out = upcast(doc)
  expect(out.theme).toBe('dark')
  expect(out.nodes[0].color).toBe('red')
  expect(out.edges[0].weight).toBe(2)
})

test('refuses documents from a newer release', () => {
  expect(() => upcast({ schemaVersion: 4, nodes: [], edges: [] })).toThrow('newer')
})

test('refuses invalid versions', () => {
  expect(() => upcast({ schemaVersion: 0 })).toThrow()
  expect(() => upcast({ schemaVersion: '2' })).toThrow()
  expect(() => upcast({ schemaVersion: 2.5 })).toThrow()
})
```
:::

## Expand → deploy → contract

The database half of the change follows the same idea. You never change a schema in a way that the
**currently running** code can't handle. Instead, each breaking change is split into releases:

| Phase | What changes | Who must cope | Example in this lesson |
|---|---|---|---|
| **Expand** | Add things: nullable columns, tables, indexes. Nothing is renamed or removed. | the *old* code, which ignores what it doesn't know | `projects.doc_schema_version int NULL` and a partial index |
| **Deploy** | New code reads old *and* new, writes new. Old data is backfilled. | the *new* code, which must handle rows the backfill hasn't reached | 1.1 writes `doc_schema_version = 3` on every save; the worker upgrades the rest |
| **Contract** | Remove the old path: drop the column, add `NOT NULL`, delete old code. | nobody: no running code uses the old path any more | `doc_schema_version` becomes `NOT NULL` with `CHECK (>= 3)` in 1.2 |

A **partial index** is an index over only the rows that match a `WHERE` clause. Here it is
`WHERE doc_schema_version IS NULL`: it contains exactly the rows the backfill still has to visit, so
"find the next old rows" stays fast, and the index shrinks to nothing as the backfill finishes.

Why does BranchStory need a column at all, when the version is inside the jsonb? Because the
database can't index, constrain or cheaply count something it has to parse out of a document.
`doc_schema_version` lets the backfill find old rows through an index, lets a dashboard show
progress in milliseconds, and lets the contract step make "no old documents left" a **database
rule** instead of a hope.

A rename, the classic breaking change, takes the same three phases. To rename `title` to `name`:
expand (add `name`, write both columns), backfill (`UPDATE … SET name = title` in batches), deploy
code that reads `name`, then contract (drop `title`) **one release later**. Done in a single
release, the old pods in the mixed-version window would query a column that no longer exists.

### What locks what

Schema changes are dangerous less because of what they do than because of the **locks** they take.
Postgres has several lock levels. Two matter here:

- **ACCESS EXCLUSIVE** blocks *everything*, including plain `SELECT`s. Most `ALTER TABLE` forms take it.
  If it is held for a long time, every request touching the table waits, the API runs out of
  connections, and readiness probes fail.
- **SHARE UPDATE EXCLUSIVE** lets reads and writes continue. `VALIDATE CONSTRAINT` and
  `CREATE INDEX CONCURRENTLY` use it.

| Statement | Lock | Fast on a big table? |
|---|---|---|
| `ADD COLUMN x int NULL` | ACCESS EXCLUSIVE, for milliseconds | yes: only the *catalog* (Postgres' own tables that describe your tables) changes |
| `ADD COLUMN x int NOT NULL DEFAULT 3` | ACCESS EXCLUSIVE, milliseconds | yes since PG 11 (the default is stored once, not written to every row) |
| `ADD COLUMN … GENERATED ALWAYS AS (…) STORED` | ACCESS EXCLUSIVE | **no**: rewrites every row. (PG 18's default `VIRTUAL` generated column is computed on read and doesn't rewrite, but it can't be indexed.) |
| `CREATE INDEX` | blocks writes for the whole build | **no** |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | yes (slower, but nobody waits). Can't run inside a transaction. |
| `ALTER COLUMN x SET NOT NULL` | ACCESS EXCLUSIVE **during a full scan** | **no**, unless a validated `CHECK (x IS NOT NULL)` already exists |
| `ADD CONSTRAINT … CHECK (…) NOT VALID` | ACCESS EXCLUSIVE, milliseconds | yes: old rows aren't checked (new writes are) |
| `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | yes: scans, but doesn't block |

:::warn title="The lock queue"
Even a millisecond `ALTER TABLE` can cause an outage. It has to *wait* for ACCESS EXCLUSIVE, and
while it waits, every new query on that table queues **behind it**. One forgotten
`BEGIN; SELECT …` in someone's `psql` session, and the whole API stalls behind a "fast" migration.
That's why the contract migration below starts with `SET lock_timeout = '5s'`: if the lock
doesn't come quickly, the statement gives up, the deploy fails visibly, and traffic keeps flowing.
:::

:::quiz id=cap-11-q3 xp=15
Which of these migrations are safe to ship in the **expand** release while 1.0 pods are still
serving? Select all that apply.
- [x] Add a nullable column `doc_schema_version`
- [x] Create an index with `CREATE INDEX CONCURRENTLY`
- [ ] Rename `projects.title` to `projects.name`
- [ ] Drop `published_stories.player_json`, because 1.1 renders the player differently
- [x] Add a new table `scene_tag_stats` that only 1.1 writes to
> Expand means **only additions the old code can ignore**. 1.0 never mentions the new column or table, and an index is invisible to queries except for being faster. A rename breaks every 1.0 query that says `title` the moment the migration runs, which is minutes before the last 1.0 pod is gone. A drop breaks 1.0's public player the same way. Both belong in a later contract release, after a release that no longer uses the old name.
:::

:::quiz id=cap-11-q4 xp=15
`projects` has two million rows. Why does the contract migration add
`CHECK (doc_schema_version IS NOT NULL) NOT VALID`, run `VALIDATE CONSTRAINT`, and only then
`SET NOT NULL`, instead of just running `ALTER COLUMN doc_schema_version SET NOT NULL`?
- [ ] `SET NOT NULL` is not supported on integer columns
- [x] A plain `SET NOT NULL` scans every row while holding ACCESS EXCLUSIVE, blocking all reads and writes; validating a check first does the scan under a weaker lock, and Postgres then skips the scan for `SET NOT NULL`
- [ ] `NOT VALID` makes Postgres ignore NULLs forever, which is faster
- [ ] It's the same work, just split up so the migration log is easier to read
> Both versions scan the table once; the difference is the **lock held during the scan**. `VALIDATE CONSTRAINT` scans under SHARE UPDATE EXCLUSIVE, so the API keeps reading and writing. Since Postgres 12, `SET NOT NULL` accepts a validated `IS NOT NULL` check as proof and only needs its exclusive lock for an instant. `NOT VALID` does not mean "ignore": new and updated rows are checked immediately; only *existing* rows are left for `VALIDATE`.
:::

:::info title="PostgreSQL 18 shortcut"
PostgreSQL 18 can also add a NOT NULL constraint itself as `NOT VALID`:
`ALTER TABLE projects ADD CONSTRAINT nn_dsv NOT NULL doc_schema_version NOT VALID;` followed by
`ALTER TABLE projects VALIDATE CONSTRAINT nn_dsv;`. This lesson uses the CHECK route because it
works on every supported version and its lock levels are long documented. If you use the PG 18
form, check the lock level for your exact version in the docs first (`ALTER TABLE`, section
"VALIDATE CONSTRAINT"): https://www.postgresql.org/docs/18/sql-altertable.html
:::

## Backward-compatible API changes

The HTTP API is a schema too, and its "old code" is every SPA tab, script and mobile build that is
still running. The rules for 1.1:

| Change | Safe? | Why |
|---|---|---|
| Add a field to a response (`tags` on nodes, `schemaVersion` on the doc) | ✅ | Clients ignore fields they don't know (System.Text.Json and `JSON.parse` both do) |
| Add an **optional** field to a request | ✅ | Old clients don't send it; the server fills in a default (the upcaster does exactly that) |
| Add an endpoint (`GET /api/features`) | ✅ | Nobody calls it until they know about it |
| Make a request field **required** | ❌ | Every old client is suddenly a 400 |
| Rename or remove a response field | ❌ | Old clients read `undefined` and break, often silently |
| Change a field's type or meaning (`tags: "a,b"` → `["a","b"]`) | ❌ | Same as a rename, but harder to notice |
| Tighten validation on existing data | ⚠️ | Only if every stored document already passes it, or old documents can't be saved any more |

So in 1.1:

- `GET /api/projects/{id}` returns the document **upcast to v3**. Old tabs don't care about the
  extra fields.
- `PUT /api/projects/{id}/doc` accepts v1, v2 and v3 bodies and **upcasts them before validating
  and saving**. A tab from last Friday keeps saving.
- `GET /api/features` is new. Old tabs never call it.
- The SignalR hub messages from cap-07 are an API too: `PatchReceived` carries node objects, so
  tags travel inside them as one more field. No hub method changes signature.
- The public player JSON (cap-08's `PlayerStory`, `format: 1`) doesn't change at all: tags are an
  authoring feature. If the player ever needs them, that's a new `format: 2`, served alongside 1
  until no cached page asks for 1.

:::tip title="Make old clients go away"
Additive changes let old tabs keep working, but you still want them to reload eventually. A cheap
trick: the API sends an `X-App-Version` header, and the SPA shows a "A new version is available —
reload" banner when it differs from its own build. Never force a reload while someone is typing.
:::

:::quiz id=cap-11-q5 xp=15
Product wants tags to show up as `sceneTags` instead of `tags` in the API. Some 1.1 browsers are
already sending `tags`. What is the backward-compatible way to rename?
- [ ] Rename the C# property; JSON is case-insensitive, so old clients are fine
- [ ] Return `sceneTags` from now on and reject requests that still send `tags` with a clear 400
- [x] Accept both on input and return both for a while, map them to one internal field, measure until nobody sends `tags`, then stop returning it in a later release
- [ ] Bump `schemaVersion` to 4; the upcaster renames the field, so no client notices
> A rename is expand → contract applied to an API: support both names, watch the traffic (a log line or metric when `tags` is used), and drop the old name only when nobody depends on it. Case-insensitive matching doesn't help with a different *name*. Rejecting old requests breaks every open tab. A schemaVersion bump does rename the field in **stored** documents, but every client that still sends or reads `tags` would break: the stored format and the wire format are separate contracts.
:::

## Feature flags: dark launch

Shipping code and releasing a feature are different events. A **feature flag** is a runtime
switch that decides whether a code path is active, so you can **deploy** 1.1 with the tag editor
switched off (a **dark launch**: the code is in production but nobody sees it) and **release** it
later by changing configuration, a few users at a time.

```text
 deploy 1.1 (flag off) → team only (allowlist) → 10 % of users → 50 % → 100 % → delete the flag
                     ▲ every arrow is a config change, not a deploy; any step can go back to "off"
```

What the flag buys you here:

- **Decoupling.** The risky part of 1.1 (new schema, upcasters, migrations) goes out on its own,
  without any user-visible change. If something is wrong, almost nobody can tell.
- **A kill switch.** If the tag UI misbehaves, `Enabled=false` turns it off for everyone in about a
  minute, with no rollback of code or data.
- **Safety for the data.** Until the flag goes on, no document contains a real tag. So rolling
  back to 1.0 (which drops unknown fields when it saves) loses nothing. The flag keeps the rollback
  door open until you are confident.

The flag in BranchStory has three settings, read from configuration (`Features:SceneTags:*`):

- `Enabled`: the kill switch. `false` means off for everyone, whatever the other settings say.
- `Users`: an allowlist of emails that always get the feature (your team, a design partner).
- `Percent`: 0 … 100, a share of all users, picked by a **stable hash** of `flag name + user id`.

"Stable" is the important word. A user must get the same answer on every request, from every pod,
after every restart. Otherwise their tag editor flickers in and out between page loads. That rules
out `Random` and also `string.GetHashCode()`, which .NET deliberately randomizes **per process**.
A SHA-256 of the input, taken modulo 100, gives every user a fixed bucket from 0 to 99; with
`Percent = 10`, buckets 0–9 are in. Raising it to 20 keeps those users and adds the next ten buckets.
Nobody who already had the feature loses it.

:::pro title="Flags gate experiences, not data formats"
The server accepts and preserves `tags` from **every** client, flag or not: Ada (flag on) and Ben
(flag off) edit the same story, and Ben's editor must not strip Ada's tags. The flag only decides
whether the tag *editor* is shown. Gating the data format per user would make one document's
shape depend on who saved it last.
:::

:::job title="Flags in real teams"
You'll meet LaunchDarkly, Unleash, Flagsmith, ConfigCat or Microsoft.FeatureManagement, often
behind the vendor-neutral **OpenFeature** SDK. They add a UI, targeting rules, audit logs and
instant updates without restarts. The concepts are the ones above. The day-one rules are the same
everywhere too: every flag has an **owner** and a **removal date**, the "off" path is tested as
carefully as the "on" path, and a flag that has been at 100 % for a month is **debt**. Delete it,
and the dead branch with it.
:::

:::quiz id=cap-11-q6 xp=15
A teammate implements the percentage rollout as
`Math.Abs($"{flag}:{userId}".GetHashCode()) % 100 < percent`. With two API pods behind Traefik,
what do users at 30 % see?
- [ ] Exactly the same as with SHA-256, because the input string is the same
- [x] The tag editor appears and disappears depending on which pod (and which process start) answered, because `string.GetHashCode` is randomized per process
- [ ] Nobody gets the feature, because `GetHashCode` can be negative
- [ ] Everybody gets the feature, because `% 100` always returns less than 30 for GUIDs
> Since .NET Core, string hashing uses a random seed chosen at process start to resist hash-flooding attacks, so the same string hashes differently in each pod and after each restart. A user's bucket changes between requests, and the UI flickers. A stable bucket needs a hash function whose output is defined by the input alone: SHA-256 (or xxHash, MurmurHash) of `flag:userId`. `Math.Abs` already handles the negative values; the problem is that the values aren't stable.
:::

:::lab id=cap-11-lab1 xp=150
title: The versioned document — upcaster, converter and the expand migration

You'll teach `BranchStory.Data` to read every document version and write v3, add the
`doc_schema_version` column (expand), and prove it with unit tests. Work from the repository root.
Start from the state cap-10 shipped and mark it, because Lab 4 deploys it again:

```bash
git status            # clean
git tag v1.0          # the release that is running on your kind cluster
docker compose -f deploy/compose.yaml up -d db
```

**1. The upcaster.** `api/BranchStory.Data/StoryDocUpcaster.cs`. It works on `JsonObject`
(raw JSON), not on the C# record, because an old shape may not fit today's types, and because
the worker will reuse this exact file without EF Core:

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BranchStory.Data;

// Public in BranchStory.Data, internal in the worker's linked copy (Lab 2 defines
// STORYDOC_LINKED there). Otherwise a project that references both assemblies, like the unit
// tests, would see two public BranchStory.Data.StoryDocUpcaster types and fail with CS0433.

/// <summary>A document written by a NEWER release than this one. Never rewrite it.</summary>
#if STORYDOC_LINKED
internal
#else
public
#endif
sealed class StoryDocTooNewException(int version)
    : JsonException($"Story document schemaVersion {version} is newer than this build understands ({StoryDocUpcaster.Current}).")
{
    public int Version { get; } = version;
}

/// <summary>
/// Brings any stored story document up to <see cref="Current"/>, one step at a time.
/// Works on raw JSON because old shapes may not fit today's C# types. Every step is
/// idempotent and keeps fields it doesn't know, so running it twice (or on a document
/// that lost its schemaVersion label) is harmless.
/// </summary>
#if STORYDOC_LINKED
internal
#else
public
#endif
static class StoryDocUpcaster
{
    public const int Current = 3;

    // Steps[n] upgrades version n+1 to n+2: Steps[0] is v1 → v2, Steps[1] is v2 → v3.
    private static readonly Action<JsonObject>[] Steps = [V1ToV2, V2ToV3];

    /// <summary>Upgrades <paramref name="doc"/> in place. Returns the version it started at.</summary>
    public static int Upcast(JsonObject doc)
    {
        var from = ReadVersion(doc);
        if (from > Current) throw new StoryDocTooNewException(from);
        for (var v = from; v < Current; v++) Steps[v - 1](doc);
        doc["schemaVersion"] = Current;
        return from;
    }

    public static int ReadVersion(JsonObject doc) => doc["schemaVersion"] switch
    {
        null => 1, // v1 documents (cap-02 … cap-10) never had the field
        JsonValue v when v.TryGetValue<int>(out var n) && n >= 1 => n,
        _ => throw new JsonException("schemaVersion must be a positive integer."),
    };

    /// <summary>v2: every field is present. v1 tolerated missing titles, labels and positions.</summary>
    private static void V1ToV2(JsonObject doc)
    {
        if (!doc.ContainsKey("startNodeId")) doc["startNodeId"] = null;
        foreach (var node in Objects(doc, "nodes"))
        {
            node["title"] ??= "";
            node["text"] ??= "";
            if (!node.ContainsKey("mediaUrl")) node["mediaUrl"] = null;
            node["x"] ??= 0;
            node["y"] ??= 0;
        }
        foreach (var edge in Objects(doc, "edges"))
            edge["label"] ??= "";
    }

    /// <summary>v3: scenes have tags. Existing tags are kept, missing ones become [].</summary>
    private static void V2ToV3(JsonObject doc)
    {
        foreach (var node in Objects(doc, "nodes"))
            if (node["tags"] is not JsonArray) node["tags"] = new JsonArray();
    }

    private static IEnumerable<JsonObject> Objects(JsonObject doc, string arrayName)
    {
        if (doc[arrayName] is not JsonArray array)
        {
            array = [];
            doc[arrayName] = array;
        }
        return array.OfType<JsonObject>().ToList();
    }
}
```

Syntax notes, in case some of it is new:

- `node["title"] ??= "";` means "if `node["title"]` is null (missing **or** JSON `null`), set it
  to `""`". `JsonNode` has implicit conversions from `string`, `int` and friends, which is why a
  plain `""` or `0` can be assigned.
- `doc["schemaVersion"] switch { null => 1, JsonValue v when … => n, _ => throw … }` is a
  *switch expression* with patterns: the first arm whose pattern matches wins.
- `#if STORYDOC_LINKED … #else … #endif` is a *preprocessor* switch: the compiler keeps one of the
  two words depending on whether the project defines that symbol. This project doesn't, so here
  the types are `public`. Lab 2 explains why the worker's copy must be `internal`.
- `StoryDocTooNewException` derives from `JsonException` on purpose: when a request body contains
  a too-new document, ASP.NET Core treats it like any malformed JSON and answers **400** without
  ever reaching the save.

**2. The document types and a converter that upcasts.** Replace `api/BranchStory.Data/StoryDoc.cs`.
The `[JsonConverter]` attribute makes **every** JSON read of a `StoryDoc` go through the upcaster:
EF Core's value converter (cap-02), request bodies in minimal APIs, and tests:

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BranchStory.Data;

/// <summary>The story graph: scenes (nodes) and choices (edges). Stored as one jsonb document.</summary>
[JsonConverter(typeof(StoryDocConverter))]
public sealed record StoryDoc(string? StartNodeId, List<StoryNode> Nodes, List<StoryEdge> Edges)
{
    /// <summary>The schemaVersion this build writes. Reading accepts 1 … this.</summary>
    public const int CurrentSchemaVersion = StoryDocUpcaster.Current;

    /// <summary>What a brand-new project starts with: one scene, which is also the start.</summary>
    public static StoryDoc Starter() =>
        new("start", [new StoryNode("start", "Opening scene", "Once upon a time...", null, 0, 0)], []);
}

/// <summary>A scene. X/Y are canvas coordinates for the editor. Tags arrived with schemaVersion 3.</summary>
public sealed record StoryNode(string Id, string Title, string Text, string? MediaUrl, double X, double Y, List<string>? Tags = null);

/// <summary>A choice that leads from one scene to another.</summary>
public sealed record StoryEdge(string Id, string From, string To, string Label);

/// <summary>
/// Every StoryDoc that is read from JSON (EF Core, request bodies, tests) goes through the
/// upcaster first, and every StoryDoc written carries the current schemaVersion.
/// </summary>
public sealed class StoryDocConverter : JsonConverter<StoryDoc>
{
    // The on-the-wire shape. A separate type, so (de)serializing it doesn't recurse into this converter.
    private sealed record Shape(int SchemaVersion, string? StartNodeId, List<StoryNode> Nodes, List<StoryEdge> Edges);

    public override StoryDoc Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var obj = JsonNode.Parse(ref reader) as JsonObject
            ?? throw new JsonException("A story document must be a JSON object.");
        StoryDocUpcaster.Upcast(obj);
        var s = obj.Deserialize<Shape>(options) ?? throw new JsonException("Empty story document.");
        var nodes = s.Nodes.Select(n => n.Tags is null ? n with { Tags = [] } : n).ToList();
        return new StoryDoc(s.StartNodeId, nodes, s.Edges);
    }

    public override void Write(Utf8JsonWriter writer, StoryDoc value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, new Shape(StoryDoc.CurrentSchemaVersion, value.StartNodeId,
            value.Nodes.Select(n => n.Tags is null ? n with { Tags = [] } : n).ToList(), value.Edges), options);
}

/// <summary>How EF Core turns a StoryDoc into jsonb text and back.</summary>
public static class StoryDocJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static string Serialize(StoryDoc doc) => JsonSerializer.Serialize(doc, Options);

    public static StoryDoc Deserialize(string json) =>
        JsonSerializer.Deserialize<StoryDoc>(json, Options) ?? StoryDoc.Starter();

    public static readonly ValueConverter<StoryDoc, string> Converter =
        new(doc => Serialize(doc), json => Deserialize(json));

    // EF's default snapshot of a class is the same reference, so in-place edits go unnoticed.
    // Compare serialized JSON, and snapshot a deep copy (JSON round trip).
    public static readonly ValueComparer<StoryDoc> Comparer =
        new((a, b) => Serialize(a!) == Serialize(b!), doc => Serialize(doc).GetHashCode(), doc => Deserialize(Serialize(doc)));
}
```

Why it's shaped this way:

- `Tags` is the **last** positional parameter with a default (`= null`), so every existing
  `new StoryNode(id, title, text, media, x, y)` in the API, the tests and `Starter()` still compiles.
- `SchemaVersion` is not a property of the record. After reading it is *always* current, so storing
  it would only invite code that compares it. The converter writes the constant.
- `n with { Tags = [] }` is a *with-expression*: a copy of the record with one property changed.
  Readers never see `null` tags.

**3. The column, on the entity.** In `api/BranchStory.Data/Entities.cs`, add to `Project` (below `Version`):

```csharp
    /// <summary>
    /// Mirrors doc.schemaVersion so SQL can find, count and (in 1.2) constrain old documents.
    /// Null = not written by 1.1 or later yet. Nullable during expand; NOT NULL after contract.
    /// </summary>
    public int? DocSchemaVersion { get; set; } = StoryDoc.CurrentSchemaVersion;
```

and add the kind constant next to `Publish` in `JobKinds`:

```csharp
    public const string UpgradeDoc = "upgrade-doc";
```

Generate the first migration **before** adding the index (step 5): a concurrent index can't run
in a transaction, so it gets a migration of its own. If it fails halfway, the column migration is
already recorded, and a retry only repeats the index.

```bash
dotnet ef migrations add DocSchemaVersionExpand --project api/BranchStory.Data --output-dir Migrations
```

Open the generated file. Its `Up` must contain exactly one `AddColumn<int>(name: "doc_schema_version", … nullable: true)`.
Nothing else: no `defaultValue`, no rename, no drop.

**4. Write the column on every save.** In `api/BranchStory.Api/Features/Projects/ProjectEndpoints.cs`
(cap-04), extend the compare-and-swap in `SaveDoc`:

```csharp
        var updated = await db.Projects
            .Where(p => p.Id == id && p.Version == expected.Value)
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.Doc, req.Doc)   // already upcast to v3 by StoryDocConverter
                .SetProperty(p => p.DocSchemaVersion, StoryDoc.CurrentSchemaVersion)
                .SetProperty(p => p.Version, newVersion)
                .SetProperty(p => p.UpdatedAt, now), ct);
```

New projects get the value from the entity's initializer. And in `StoryDocRules.Validate` (cap-04),
inside the `foreach (var n in doc.Nodes)` loop, add the tag rules (the editor in Lab 3 normalizes
to the same rules, so a 400 here means a buggy or hostile client):

```csharp
            if (n.Tags is { Count: > 10 }) Add("doc.nodes", $"Scene '{n.Id}' has more than 10 tags.");
            foreach (var tag in n.Tags ?? [])
                if (!TagPattern.IsMatch(tag)) Add("doc.nodes", $"Scene '{n.Id}' has an invalid tag '{tag}'.");
```

with this field in the `StoryDocRules` class (plus `using System.Text.RegularExpressions;`):

```csharp
    // lower-case letters, digits and dashes, 1–24 characters, not starting with a dash
    static readonly Regex TagPattern = new("^[a-z0-9][a-z0-9-]{0,23}$", RegexOptions.Compiled);
```

This is new validation on existing data, the ⚠️ row of the compatibility table. It is safe here
only because no stored document has tags yet.

**5. The backfill index, created concurrently.** In `api/BranchStory.Data/Configurations/ProjectConfig.cs`,
next to `b.HasIndex(p => p.OwnerId);`:

```csharp
        // Expand (1.1): finds rows the backfill hasn't reached. Partial, so it shrinks to nothing
        // as the backfill runs; CONCURRENTLY, so building it doesn't block writes. Dropped in 1.2.
        b.HasIndex(p => p.Id)
            .HasDatabaseName("ix_projects_doc_schema_version_null")
            .HasFilter("doc_schema_version IS NULL")
            .IsCreatedConcurrently();
```

```bash
dotnet ef migrations add DocSchemaVersionIndex --project api/BranchStory.Data --output-dir Migrations
dotnet ef migrations script DocSchemaVersionExpand DocSchemaVersionIndex --project api/BranchStory.Data
```

`migrations script FROM TO` prints the migrations *after* `FROM` up to and including `TO`, so this
shows only the index migration. Note what is missing: there is no `START TRANSACTION`, because
Npgsql takes a concurrent index *out* of the migration transaction by itself:

```text
CREATE INDEX CONCURRENTLY ix_projects_doc_schema_version_null ON projects (id) WHERE doc_schema_version IS NULL;

INSERT INTO "__EFMigrationsHistory" (migration_id, product_version)
VALUES ('…_DocSchemaVersionIndex', '10.0.…');
```

(The expand migration, by contrast, is wrapped in `START TRANSACTION; … COMMIT;`, which is fine for
an instant `ALTER TABLE projects ADD doc_schema_version integer;`.)

:::warn title="A failed concurrent index leaves a corpse"
If `CREATE INDEX CONCURRENTLY` is interrupted, Postgres keeps an **INVALID** index that is updated
on every write but never used. `\d projects` marks it `INVALID`. Drop it with
`DROP INDEX CONCURRENTLY IF EXISTS ix_projects_doc_schema_version_null;` and run the migration again.
:::

**6. Unit tests.** `tests/BranchStory.UnitTests/StoryDocUpcasterTests.cs` (the cap-09 unit test project):

```bash
dotnet add tests/BranchStory.UnitTests reference api/BranchStory.Data
```

```csharp
using System.Text.Json.Nodes;
using BranchStory.Data;

namespace BranchStory.UnitTests;

public class StoryDocUpcasterTests
{
    // A v1 document as cap-02 … cap-10 stored it: no schemaVersion, some optional fields missing.
    private const string V1 = """
        {"startNodeId":"a",
         "nodes":[{"id":"a","title":"Gate","text":"A gate.","x":10,"y":20},{"id":"b","text":"Inside."}],
         "edges":[{"id":"e1","from":"a","to":"b"}]}
        """;

    private static JsonObject Parse(string json) => (JsonObject)JsonNode.Parse(json)!;

    [Fact]
    public void V1_is_upgraded_to_the_current_version()
    {
        var doc = Parse(V1);
        Assert.Equal(1, StoryDocUpcaster.Upcast(doc));
        Assert.Equal(3, (int)doc["schemaVersion"]!);
        var b = doc["nodes"]![1]!;
        Assert.Equal("", (string)b["title"]!);
        Assert.Equal(0, (int)b["x"]!);
        Assert.Empty(b["tags"]!.AsArray());
        Assert.Equal("", (string)doc["edges"]![0]!["label"]!);
    }

    [Fact]
    public void Upcasting_twice_changes_nothing()
    {
        var once = Parse(V1);
        StoryDocUpcaster.Upcast(once);
        var twice = once.DeepClone().AsObject();
        Assert.Equal(3, StoryDocUpcaster.Upcast(twice));
        Assert.True(JsonNode.DeepEquals(once, twice));
    }

    [Fact]
    public void Tags_survive_a_document_that_lost_its_label()
    {
        // An old SPA tab (normalizeDoc from cap-05) drops schemaVersion but keeps node objects.
        var doc = Parse("""{"startNodeId":"a","nodes":[{"id":"a","title":"A","text":"","x":0,"y":0,"tags":["intro"]}],"edges":[]}""");
        StoryDocUpcaster.Upcast(doc);
        Assert.Equal("intro", (string)doc["nodes"]![0]!["tags"]![0]!);
    }

    [Fact]
    public void Unknown_fields_are_kept()
    {
        var doc = Parse("""{"schemaVersion":2,"startNodeId":null,"nodes":[{"id":"a","title":"","text":"","mediaUrl":null,"x":0,"y":0,"color":"red"}],"edges":[],"theme":"dark"}""");
        StoryDocUpcaster.Upcast(doc);
        Assert.Equal("dark", (string)doc["theme"]!);
        Assert.Equal("red", (string)doc["nodes"]![0]!["color"]!);
    }

    [Fact]
    public void A_newer_document_is_refused_not_downgraded()
    {
        var ex = Assert.Throws<StoryDocTooNewException>(() => StoryDocUpcaster.Upcast(Parse("""{"schemaVersion":4,"nodes":[],"edges":[]}""")));
        Assert.Equal(4, ex.Version);
    }

    [Fact]
    public void The_json_converter_upcasts_on_read_and_stamps_on_write()
    {
        var doc = StoryDocJson.Deserialize(V1);
        Assert.Equal(["", "Gate"], doc.Nodes.Select(n => n.Title).Order());
        Assert.All(doc.Nodes, n => Assert.NotNull(n.Tags));

        var written = Parse(StoryDocJson.Serialize(doc));
        Assert.Equal(3, (int)written["schemaVersion"]!);
        Assert.Empty(written["nodes"]![0]!["tags"]!.AsArray());
    }
}
```

```bash
dotnet build
dotnet test tests/BranchStory.UnitTests --filter StoryDocUpcasterTests
dotnet test tests/BranchStory.Api.Tests      # cap-03/04 integration tests must stay green
```

Expected: `Passed!  - Failed: 0, Passed: 6` for the filter, and the API tests unchanged.

**7. See old documents being upgraded on read.** Run the API (`dotnet run --project api/BranchStory.Api`,
which migrates on startup in Development), create a project, then turn its document back into a
v1 document behind the API's back:

```bash
tok() { curl -s -X POST localhost:5080/api/dev/token -H 'content-type: application/json' \
  -d "{\"username\":\"$1\"}" | jq -r .accessToken; }
LENA=$(tok lena)   # a fresh user: ada already owns the free plan's 3 projects (cap-05)
ID=$(curl -s -X POST localhost:5080/api/projects -H "authorization: Bearer $LENA" \
  -H 'content-type: application/json' -d '{"title":"Legacy tale"}' | jq -r .id)

docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -c \
  "UPDATE projects SET doc = '{\"startNodeId\":\"start\",\"nodes\":[{\"id\":\"start\",\"text\":\"Old\"}],\"edges\":[]}', doc_schema_version = NULL WHERE id = '$ID'"

curl -s localhost:5080/api/projects/$ID -H "authorization: Bearer $LENA" | jq -c .doc
docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -c '\d projects' | grep -E 'doc_schema|ix_projects_doc'
```

Expected:

```text
{"schemaVersion":3,"startNodeId":"start","nodes":[{"id":"start","title":"","text":"Old","mediaUrl":null,"x":0,"y":0,"tags":[]}],"edges":[]}
 doc_schema_version | integer                  |           |          |
    "ix_projects_doc_schema_version_null" btree (id) WHERE doc_schema_version IS NULL
```

The row in the database is still v1. Only the API's view of it is v3.

Now play a 1.0 browser tab: save a **v1 body** (no `schemaVersion`, no `tags`, no `mediaUrl`)
through the 1.1 API. It must still work, and the stored row comes out as v3:

```bash
VER=$(curl -s localhost:5080/api/projects/$ID -H "authorization: Bearer $LENA" | jq .version)
curl -s -X PUT localhost:5080/api/projects/$ID/doc -H "authorization: Bearer $LENA" \
  -H 'content-type: application/json' \
  -d "{\"expectedVersion\":$VER,\"doc\":{\"startNodeId\":\"start\",\"nodes\":[{\"id\":\"start\",\"title\":\"Old\",\"text\":\"Saved by a 1.0 tab\",\"x\":0,\"y\":0}],\"edges\":[]}}"
docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -c \
  "SELECT doc_schema_version, doc->>'schemaVersion' AS sv, doc->'nodes'->0->'tags' AS tags FROM projects WHERE id = '$ID'"
```

Expected: the `PUT` answers `{"version":…,"updatedAt":"…"}` (HTTP 200), and the row shows
`3 | 3 | []`. You don't need to keep this project: Lab 2 turns every row back into a v1 lookalike.

- [ ] `DocSchemaVersionExpand` adds only a nullable column, and `DocSchemaVersionIndex` creates the partial index `CONCURRENTLY`
- [ ] The six `StoryDocUpcasterTests` pass, and the existing API integration tests still pass
- [ ] `GET /api/projects/{id}` returns a v3 document with `tags: []` for a row that is stored as v1
- [ ] A `PUT …/doc` with a v1 body (no `schemaVersion`) still saves (200), and the stored row then has `doc_schema_version = 3`
:::

## The backfill

A **backfill** rewrites existing rows into the new shape in the background. The upcaster already
makes old rows *readable*; the backfill makes them *gone*, so that 1.2 can contract.

The rules, each learned the hard way somewhere:

1. **Start it only after the rollout is complete.** A 1.0 API pod still serving would save
   documents without touching `doc_schema_version`. And a 1.0 **worker** has no `upgrade-doc`
   handler: cap-08's claim doesn't filter by kind, so it would take those jobs and dead-letter them
   as `unknown kind`. Wait until `kubectl rollout status` is done and no 1.0 pod is left.
2. **Don't change content, so don't bump `projects.version`.** The backfill changes the
   *representation* of a story, not the story. If it bumped `version`, every editor with that story
   open would get a 409 conflict on their next autosave (cap-04) for a change they can't even see.
   It also leaves `updated_at` alone, so the "recently edited" list doesn't reshuffle.
3. **Lose races safely.** The write is a compare-and-swap on `version`, exactly like cap-04's save:
   `UPDATE … WHERE id = @id AND version = @read`. If a user saved in between, zero rows change,
   and the job reads again. A user's save always wins.
4. **Idempotent and resumable.** Running it twice, or killing it halfway, must be harmless. The
   upcaster is idempotent and the job queue (cap-08) has leases and retries, so both come for free.
5. **Paced.** A backfill shares the database (and here, the job queue) with real users. It must be
   slow enough that p95 latency doesn't move.
6. **Observable.** One query must answer "how far along is it?", and another "is it done?".

BranchStory's backfill reuses the cap-08 worker. One **`upgrade-doc` job per project**:

- The `FOR UPDATE SKIP LOCKED` claim you already wrote lets both worker replicas take jobs in
  parallel without ever upgrading the same project twice at the same time.
- A document the upcaster can't read fails **alone**: it lands in `failed` with its `last_error`,
  and the other projects go on. That's your list of broken documents to look at.
- Leases, retries with backoff and dead-lettering already exist and are tested (cap-09).

The one new problem is the queue itself. cap-08's claim takes jobs `ORDER BY run_after, id`. If
you enqueue 100,000 upgrade jobs with `run_after = now()`, a user's **Publish** waits behind all of
them. The fix is to give each job its own start time: job *n* gets `run_after = now() + n × 50 ms`.
That paces the backfill at about 20 projects per second, and a publish (with `run_after = now()`)
always sorts in front of the backfill jobs that aren't due yet.

```sql
-- deploy/ops/backfill-v3.sql: enqueue one paced upgrade job per project that needs it.
-- Safe to run again: the idempotency key makes a duplicate a no-op. Bump "r1" to re-enqueue
-- projects whose earlier job already succeeded (for example after a rollback to 1.0).
INSERT INTO jobs (kind, project_id, payload, status, attempts, max_attempts, run_after,
                  idempotency_key, created_at, updated_at)
SELECT 'upgrade-doc', p.id, '{"target":3}', 'queued', 0, 5,
       now() + make_interval(secs => 0.05 * row_number() OVER (ORDER BY p.id)),
       'upgrade-doc:3:r1:' || p.id, now(), now()
FROM projects p
WHERE p.doc_schema_version IS DISTINCT FROM 3
   OR p.doc->>'schemaVersion' IS DISTINCT FROM '3'
ON CONFLICT (idempotency_key) DO NOTHING;
```

`IS DISTINCT FROM` is `<>` that treats NULL as a normal value: `NULL IS DISTINCT FROM 3` is
`true`, while `NULL <> 3` is `NULL` (which `WHERE` treats as false). The `doc->>'schemaVersion'`
half catches the rare row whose column says 3 but whose document doesn't, which only a rollback to
1.0 can produce (see the rollback plan).

:::info title="Plan B: a pure-SQL backfill"
When a step is simple enough to express in SQL, you don't need a worker at all: a loop of small
`UPDATE` batches is faster. v2 → v3 is such a step (add `tags: []`, set the version); v1 → v2 also
needs defaults per field, so BranchStory uses the C# upcaster for everything and keeps one source of
truth. The batched-SQL pattern is still worth knowing, and it's the next exercise. Its shape:
`WHERE id IN (SELECT id … ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED)`. Each batch is one short
transaction, rows a user is saving right now are skipped (and picked up by a later batch), and two
copies of the script can run side by side.
:::

:::sql id=cap-11-sql1 db=empty xp=50
title: One batch of a SQL backfill
The `projects` table below has stories in schema versions 1, 2 and 3. Write **one batch** of the
v2 → v3 backfill as a single `UPDATE`:

- Pick at most **3** rows with `doc_schema_version = 2`, **lowest `id` first**, and skip rows that
  are locked by someone else (`FOR UPDATE SKIP LOCKED`).
- In those rows, set `doc.schemaVersion` to `3`, and give every node that has no `tags` key
  `"tags": []`, keeping the node order and all other fields.
- Set `doc_schema_version` to `3`.
- Do **not** change `version` (the content didn't change) and don't touch v1 rows (they need the C# upcaster).

The grader inspects the whole table afterwards.

hint: `doc || jsonb_build_object('schemaVersion', 3, 'nodes', …)`: `||` merges two objects, and the right-hand keys win.
hint: Rebuild the array: `SELECT coalesce(jsonb_agg(… ORDER BY i), '[]'::jsonb) FROM jsonb_array_elements(p.doc -> 'nodes') WITH ORDINALITY AS t(n, i)`. `jsonb_agg` over zero rows is NULL, hence the `coalesce`.
hint: For one node: `CASE WHEN n ? 'tags' THEN n ELSE n || '{"tags": []}' END`. `?` asks "does this object have the key?".

```sql setup
CREATE TABLE projects (
  id int PRIMARY KEY,
  title text NOT NULL,
  doc jsonb NOT NULL,
  version int NOT NULL,
  doc_schema_version int
);
INSERT INTO projects VALUES
 (1, 'The Gate', '{"schemaVersion":2,"startNodeId":"a","nodes":[{"id":"a","title":"Gate","text":"","mediaUrl":null,"x":0,"y":0},{"id":"b","title":"Yard","text":"","mediaUrl":null,"x":200,"y":0}],"edges":[{"id":"e1","from":"a","to":"b","label":"Enter"}]}', 7, 2),
 (2, 'Moon Base', '{"schemaVersion":3,"startNodeId":"m","nodes":[{"id":"m","title":"Dock","text":"","mediaUrl":null,"x":0,"y":0,"tags":["intro"]}],"edges":[]}', 3, 3),
 (3, 'Sea Story', '{"schemaVersion":2,"startNodeId":"s","nodes":[{"id":"s","title":"Shore","text":"","mediaUrl":null,"x":0,"y":0}],"edges":[]}', 1, 2),
 (4, 'Old Tale', '{"startNodeId":"o","nodes":[{"id":"o","text":"Once."}],"edges":[]}', 12, NULL),
 (5, 'Fog', '{"schemaVersion":2,"startNodeId":null,"nodes":[],"edges":[]}', 2, 2),
 (6, 'Ice Cave', '{"schemaVersion":2,"startNodeId":"i","nodes":[{"id":"i","title":"Cave","text":"","mediaUrl":null,"x":0,"y":0}],"edges":[]}', 5, 2);
```

```sql starter
UPDATE projects
SET doc_schema_version = 3
WHERE doc_schema_version = 2;
```

```sql solution
UPDATE projects AS p
SET doc = p.doc || jsonb_build_object(
        'schemaVersion', 3,
        'nodes', (SELECT coalesce(jsonb_agg(CASE WHEN n ? 'tags' THEN n ELSE n || '{"tags": []}' END ORDER BY i), '[]'::jsonb)
                  FROM jsonb_array_elements(p.doc -> 'nodes') WITH ORDINALITY AS t(n, i))),
    doc_schema_version = 3
WHERE p.id IN (
    SELECT id FROM projects
    WHERE doc_schema_version = 2
    ORDER BY id
    LIMIT 3
    FOR UPDATE SKIP LOCKED);
```

```sql check
SELECT id, doc_schema_version, version, doc FROM projects ORDER BY id;
```
:::

:::quiz id=cap-11-q7 xp=15
Your first draft of the backfill writes `SET doc = @doc, version = version + 1, updated_at = now()`.
Ada has a story open in the editor while the backfill passes over it. What happens?
- [ ] Nothing visible: autosave sends the new version number automatically
- [x] Ada's next autosave is refused with 409 because her `expectedVersion` is now stale, and she sees a conflict dialog for a change she can't see; her story also jumps to the top of everyone's "recent" list
- [ ] The backfill's `UPDATE` fails because Ada holds a lock on the row while editing
- [ ] Ada's tags are deleted, because her editor doesn't know about schemaVersion 3
> `version` is the optimistic-concurrency token from cap-04, so bumping it tells every open editor "someone else saved". Multiply that by every open story during a backfill and support gets a flood of mysterious conflicts. A representation change is not a content change: leave `version` and `updated_at` alone, and guard the write with `WHERE version = @read` so a real save in between wins. Editors don't hold row locks between autosaves, and her tags are safe either way, because the upcaster keeps them.
:::

:::lab id=cap-11-lab2 xp=130
title: The backfill job on the cap-08 worker

You'll add an `upgrade-doc` handler to `BranchStory.Worker`, share the upcaster with it without
pulling in EF Core, keep backfill events out of the editors' SignalR feed, and run the backfill
against the legacy project from Lab 1.

**1. Share the upcaster's source file.** `StoryDocUpcaster.cs` only uses `System.Text.Json`, so the
worker can compile the same file directly. This is called *linking* a file: one source of truth,
no new project, no EF Core in the worker. Add to `worker/BranchStory.Worker/BranchStory.Worker.csproj`,
before `</Project>`:

```xml
  <PropertyGroup>
    <!-- Makes the linked copy internal (see the #if in StoryDocUpcaster.cs). -->
    <DefineConstants>$(DefineConstants);STORYDOC_LINKED</DefineConstants>
  </PropertyGroup>
  <ItemGroup>
    <!-- One source of truth for the upcaster, without pulling EF Core into the worker. -->
    <Compile Include="..\..\api\BranchStory.Data\StoryDocUpcaster.cs" Link="Docs\StoryDocUpcaster.cs" />
  </ItemGroup>
```

Why `STORYDOC_LINKED`? Linking compiles the file into **two** assemblies, `BranchStory.Data` and
`BranchStory.Worker`. cap-09's unit test project references the worker, and Lab 1 made it
reference `BranchStory.Data` too, so it would now see two public `BranchStory.Data.StoryDocUpcaster`
types and stop compiling with `CS0433: The type 'StoryDocUpcaster' exists in both …`. With the
symbol defined, the worker's copy is `internal`: the worker itself can use it, nobody else sees it.

The worker's Docker build (cap-10) only copies `worker/` and `ServiceDefaults`, so add one line to
`worker/Dockerfile`, right after `COPY worker/ worker/`:

```dockerfile
COPY api/BranchStory.Data/StoryDocUpcaster.cs api/BranchStory.Data/
```

**2. The handler.** `worker/BranchStory.Worker/Docs/UpgradeDocHandler.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;
using BranchStory.Data;
using BranchStory.Worker.Jobs;
using Npgsql;

namespace BranchStory.Worker.Docs;

/// <summary>
/// Backfill: rewrites one project's doc in the current schemaVersion. Idempotent: an already
/// current document is left untouched. It never changes the story's content, so it does NOT
/// bump projects.version or updated_at, and open editors keep saving without a 409.
/// </summary>
public sealed class UpgradeDocHandler(NpgsqlDataSource db, ILogger<UpgradeDocHandler> log) : IJobHandler
{
    public const string KindName = "upgrade-doc";
    public string Kind => KindName;

    public async Task<string?> HandleAsync(ClaimedJob job, CancellationToken ct)
    {
        // A save can land between our read and our write. The write is a compare-and-swap on
        // version (like cap-04's save), so we lose the race safely and simply read again.
        for (var round = 1; round <= 5; round++)
        {
            string json;
            int version;
            int? column;
            await using (var read = db.CreateCommand(
                "SELECT doc::text, version, doc_schema_version FROM projects WHERE id = @id"))
            {
                read.Parameters.AddWithValue("id", job.ProjectId);
                await using var r = await read.ExecuteReaderAsync(ct);
                if (!await r.ReadAsync(ct)) return "project deleted, nothing to upgrade";
                json = r.GetString(0);
                version = r.GetInt32(1);
                column = r.IsDBNull(2) ? null : r.GetInt32(2);
            }

            var doc = JsonNode.Parse(json) as JsonObject
                ?? throw new PermanentJobException("doc is not a JSON object");
            int from;
            try { from = StoryDocUpcaster.Upcast(doc); }
            catch (JsonException ex) { throw new PermanentJobException($"cannot upcast: {ex.Message}"); }

            if (from == StoryDocUpcaster.Current && column == StoryDocUpcaster.Current)
                return "already current"; // no write, no dead tuple

            await using var write = db.CreateCommand("""
                UPDATE projects
                SET doc = @doc::jsonb, doc_schema_version = @schema
                WHERE id = @id AND version = @version
                """);
            write.Parameters.AddWithValue("doc", doc.ToJsonString());
            write.Parameters.AddWithValue("schema", StoryDocUpcaster.Current);
            write.Parameters.AddWithValue("id", job.ProjectId);
            write.Parameters.AddWithValue("version", version);
            if (await write.ExecuteNonQueryAsync(ct) == 1)
                return $"v{from} -> v{StoryDocUpcaster.Current}";

            log.LogInformation("Project {ProjectId} was saved during the upgrade (round {Round}); re-reading",
                job.ProjectId, round);
        }
        // An ordinary exception: the runner retries with backoff (cap-08).
        throw new InvalidOperationException("the project kept changing; will retry later");
    }
}
```

Things to notice:

- **A deleted project is success**, not failure. The goal ("this project is not old any more") is
  reached. Retrying a job that can never succeed only fills the dead-letter list with noise.
- **An unreadable document is permanent**: `PermanentJobException` dead-letters it at once with
  the reason (cap-08). Retrying won't fix the JSON.
- **"Kept changing" is transient**: a plain exception gets cap-08's exponential backoff, so a
  story that is being edited heavily right now is tried again a little later.

**3. Register it.** In `worker/BranchStory.Worker/Program.cs`, next to the publish handler:

```csharp
builder.Services.AddSingleton<IJobHandler, BranchStory.Worker.Docs.UpgradeDocHandler>();
```

The `JobRunner` builds its kind → handler dictionary from all registered `IJobHandler`s, so nothing
else changes. Startup now logs `starting 2 loops for kinds publish,upgrade-doc` (plus `demo` in
Development).

**4. Keep the backfill out of the editors' SignalR feed.** Every job transition fires
`pg_notify('job_events', …)`, and cap-08's `JobEventsListener` broadcasts it to the project's
SignalR group. 100,000 upgrade jobs would mean 200,000 messages that no editor needs. In
`api/BranchStory.Api/Features/Publishing/JobEventsListener.cs`, change the last line of
`OnNotification`:

```csharp
        // Only publish jobs have a UI. Backfill jobs (upgrade-doc) would only be noise for editors.
        if (job is not null && job.Kind == JobKinds.Publish) _ = BroadcastAsync(job);
```

**5. Save the enqueue script and a progress query.** Create `deploy/ops/backfill-v3.sql` with the
`INSERT … SELECT` from the section above, and `deploy/ops/backfill-v3-progress.sql`:

```sql
-- How far along is it?
SELECT status, count(*) FROM jobs WHERE kind = 'upgrade-doc' GROUP BY status ORDER BY status;
-- Is it done? (Must be 0 before the contract release.)
SELECT count(*) AS remaining FROM projects
WHERE doc_schema_version IS DISTINCT FROM 3 OR doc->>'schemaVersion' IS DISTINCT FROM '3';
-- What failed, and why?
SELECT project_id, attempts, last_error FROM jobs
WHERE kind = 'upgrade-doc' AND status = 'failed' ORDER BY id LIMIT 20;
```

**6. Run it locally.** API from Lab 1 running, worker in a second terminal
(`dotnet run --project worker/BranchStory.Worker`). If cap-10's compose stack is still up, stop
its worker first (`docker compose -f deploy/compose.yaml stop worker`). That container still runs
1.0, which has no `upgrade-doc` handler, so it would claim the new jobs and dead-letter them as
"no handler for kind 'upgrade-doc'": the mixed-version window in miniature. Make a few more legacy
rows, then enqueue:

```bash
PSQL="docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -d branchstory"
$PSQL -c "UPDATE projects SET doc = doc - 'schemaVersion', doc_schema_version = NULL"
$PSQL -f /dev/stdin < deploy/ops/backfill-v3-progress.sql     # remaining = all your projects
$PSQL -f /dev/stdin < deploy/ops/backfill-v3.sql              # INSERT 0 <n>
$PSQL -f /dev/stdin < deploy/ops/backfill-v3.sql              # INSERT 0 0: idempotent
```

(`doc - 'schemaVersion'` removes a key from a jsonb object, which turns every v3 document into
one that *claims* to be v1, a good test of idempotency.) The worker log shows one line per project,
about 20 per second (cap-08's idle loop polls once a second, so they arrive in small bursts). Since
cap-10 the log is JSON, so pipe it through `jq -r .Message` (or read the `Message` field) to see:

```text
Job succeeded in 6.1 ms: v1 -> v3
Job succeeded in 4.8 ms: v1 -> v3
```

Then:

```bash
$PSQL -f /dev/stdin < deploy/ops/backfill-v3-progress.sql
```

```text
  status   | count
-----------+-------
 succeeded |     4
 remaining
-----------
         0
```

(`4` is however many projects you have.)

**7. Pause and resume.** A backfill you can't stop is an incident waiting to happen. Pausing
doesn't need a deploy, because jobs that aren't due are simply not claimed:

```bash
# pause
$PSQL -c "UPDATE jobs SET run_after = 'infinity' WHERE kind = 'upgrade-doc' AND status = 'queued'"
# resume: number the waiting jobs 1, 2, 3 … again and space them 50 ms apart from now
$PSQL -c "UPDATE jobs AS j SET run_after = now() + make_interval(secs => 0.05 * q.n), updated_at = now()
          FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM jobs
                WHERE kind = 'upgrade-doc' AND status = 'queued') AS q
          WHERE j.id = q.id"
```

Running jobs finish their current project, and nothing new is claimed. `infinity` is a real
`timestamptz` value that is later than every other timestamp. The resume uses the same
`row_number()` trick as the enqueue script, so the pace after a pause is the pace before it.

:::tip title="Watch the database, not just the job"
While a large backfill runs, keep an eye on what it costs: the API's **p95 latency** (the time
within which 95 % of requests finish, on cap-10's dashboard),
`SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'projects'` (Postgres never overwrites a
row in place: an `UPDATE` writes a new copy and leaves the old one behind as a **dead tuple** until
autovacuum cleans it up) and replication lag if you have replicas. If any of them
moves, pause and increase the 50 ms.
:::

- [ ] The worker starts with `upgrade-doc` among its kinds and builds with the linked `StoryDocUpcaster.cs`
- [ ] Running `backfill-v3.sql` twice enqueues each project once (`INSERT 0 0` the second time)
- [ ] After the jobs finish, the progress query reports `remaining = 0`, and `projects.version` / `updated_at` of the upgraded rows are unchanged
- [ ] While the backfill runs, a `POST …/publish` still finishes within a few seconds (its job sorts before the paced upgrade jobs)
- [ ] An editor with a project open sees no `JobUpdated` events for upgrade jobs
:::

:::lab id=cap-11-lab3 xp=130
title: Dark-launch the tag editor behind a feature flag

You'll add the flag service and `GET /api/features` to the API, make the SPA round-trip fields it
doesn't know, and add a tag editor that only appears when the flag is on.

**1. The flag service.** `api/BranchStory.Api/Features/Flags/FeatureFlags.cs`:

```csharp
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace BranchStory.Api.Features.Flags;

/// <summary>The flags this build knows. A flag is deleted from here (and config) once it is fully rolled out.</summary>
public static class Flags
{
    public const string SceneTags = "SceneTags";
    public static readonly string[] All = [SceneTags];
}

/// <summary>Config for one flag, e.g. Features:SceneTags:Enabled / :Percent / :Users:0.</summary>
public sealed class FlagRule
{
    /// <summary>Kill switch. False = off for everybody, whatever the other settings say.</summary>
    public bool Enabled { get; set; }
    /// <summary>0 … 100: share of users who get it, chosen by a stable hash of the user id.</summary>
    public int Percent { get; set; }
    /// <summary>Emails that always get it while Enabled is true (the team, design partners).</summary>
    public List<string> Users { get; set; } = [];
}

public sealed class FeatureFlags(IOptionsMonitor<Dictionary<string, FlagRule>> options)
{
    public bool IsEnabled(string flag, Guid userId, string email)
    {
        if (!options.CurrentValue.TryGetValue(flag, out var rule) || !rule.Enabled) return false;
        if (rule.Users.Contains(email, StringComparer.OrdinalIgnoreCase)) return true;
        return Bucket(flag, userId) < Math.Clamp(rule.Percent, 0, 100);
    }

    /// <summary>
    /// 0 … 99, the same on every pod and after every restart (string.GetHashCode is randomized per
    /// process, so it can't be used). The flag name is part of the input, so the first 10 % of
    /// one flag are not automatically the first 10 % of every flag.
    /// </summary>
    public static int Bucket(string flag, Guid userId)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes($"{flag}:{userId}"), hash);
        return (int)(BinaryPrimitives.ReadUInt32BigEndian(hash) % 100);
    }
}
```

`IOptionsMonitor` (instead of `IOptions`) re-reads configuration when it changes, so a flag
provider that updates config live (Azure App Configuration, a mounted file with `reloadOnChange`)
works without a restart. On kind the ConfigMap change rolls the pods anyway (Lab 4).

**2. The endpoint.** `api/BranchStory.Api/Features/Flags/FeatureEndpoints.cs`:

```csharp
using System.Text.Json;
using BranchStory.Api.Auth;
using Microsoft.AspNetCore.Http.HttpResults;

namespace BranchStory.Api.Features.Flags;

public static class FeatureEndpoints
{
    /// <summary>GET /api/features → { "sceneTags": true } for the calling user. New in 1.1 (additive).</summary>
    public static RouteGroupBuilder MapFeatureEndpoints(this RouteGroupBuilder api)
    {
        api.MapGet("/features", GetFeatures).WithTags("Features").WithName("GetFeatures");
        return api;
    }

    static async Task<Ok<Dictionary<string, bool>>> GetFeatures(
        CurrentUser currentUser, FeatureFlags flags, HttpContext http, CancellationToken ct)
    {
        var me = await currentUser.GetAsync(ct);
        http.Response.Headers.CacheControl = "private, no-store"; // per user; never cache in a proxy
        // Dictionary keys are not camel-cased by the JSON options, so convert them explicitly.
        return TypedResults.Ok(Flags.All.ToDictionary(
            JsonNamingPolicy.CamelCase.ConvertName, f => flags.IsEnabled(f, me.Id, me.Email)));
    }
}
```

In `api/BranchStory.Api/Program.cs`, register the service and map the route:

```csharp
using BranchStory.Api.Features.Flags;

// … next to the other registrations
builder.Services.Configure<Dictionary<string, FlagRule>>(builder.Configuration.GetSection("Features"));
builder.Services.AddSingleton<FeatureFlags>();

// … in the /api group
api.MapFeatureEndpoints();
```

In `api/BranchStory.Api/appsettings.json` the flag is **off** (this file ships to every environment):

```json
  "Features": {
    "SceneTags": { "Enabled": false, "Percent": 0, "Users": [] }
  }
```

and in `appsettings.Development.json` on for you only:

```json
  "Features": {
    "SceneTags": { "Enabled": true, "Users": [ "ada@branchstory.test" ] }
  }
```

**3. Unit tests for the flag rules.** `tests/BranchStory.UnitTests/FeatureFlagsTests.cs`:

```bash
dotnet add tests/BranchStory.UnitTests reference api/BranchStory.Api
dotnet add tests/BranchStory.UnitTests package Microsoft.Extensions.Configuration
```

```csharp
using BranchStory.Api.Features.Flags;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace BranchStory.UnitTests;

public class FeatureFlagsTests
{
    private static FeatureFlags Build(Dictionary<string, string?> settings)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection();
        services.Configure<Dictionary<string, FlagRule>>(config.GetSection("Features"));
        return new FeatureFlags(services.BuildServiceProvider().GetRequiredService<IOptionsMonitor<Dictionary<string, FlagRule>>>());
    }

    [Fact]
    public void Unknown_or_disabled_flags_are_off()
    {
        var flags = Build(new() { ["Features:SceneTags:Enabled"] = "false", ["Features:SceneTags:Percent"] = "100" });
        Assert.False(flags.IsEnabled(Flags.SceneTags, Guid.NewGuid(), "a@b.test"));
        Assert.False(flags.IsEnabled("Nope", Guid.NewGuid(), "a@b.test"));
    }

    [Fact]
    public void Allowlisted_users_get_it_at_zero_percent()
    {
        var flags = Build(new() { ["Features:SceneTags:Enabled"] = "true", ["Features:SceneTags:Users:0"] = "Ada@BranchStory.test" });
        Assert.True(flags.IsEnabled(Flags.SceneTags, Guid.NewGuid(), "ada@branchstory.test"));
        Assert.False(flags.IsEnabled(Flags.SceneTags, Guid.NewGuid(), "ben@branchstory.test"));
    }

    [Fact]
    public void Percent_rollout_is_stable_and_roughly_right()
    {
        var flags = Build(new() { ["Features:SceneTags:Enabled"] = "true", ["Features:SceneTags:Percent"] = "20" });
        var users = Enumerable.Range(0, 5000).Select(_ => Guid.NewGuid()).ToList();
        var on = users.Count(u => flags.IsEnabled(Flags.SceneTags, u, "x@y.test"));
        Assert.InRange(on, 850, 1150);                       // ≈ 20 % of 5000
    }

    [Fact]
    public void Buckets_are_the_same_in_every_process()
    {
        // A golden value: SHA-256("SceneTags:00000000-0000-0000-0000-000000000001") starts with
        // bytes whose big-endian uint % 100 is 16, on every machine, pod and .NET version.
        // string.GetHashCode would give a different number on every run of this test.
        var user = Guid.Parse("00000000-0000-0000-0000-000000000001");
        Assert.Equal(16, FeatureFlags.Bucket(Flags.SceneTags, user));
    }
}
```

```bash
dotnet test tests/BranchStory.UnitTests      # Passed: 10 (6 upcaster + 4 flags), plus your cap-09 tests
```

**4. Make the SPA a tolerant reader.** Four places in the 1.0 frontend build a *new* top-level
document object from the three fields they know (`startNodeId`, `nodes`, `edges`) and so **drop**
any other top-level field: `normalizeDoc` (cap-05), `deleteNode` and `mergeDocs` (cap-06) and
`applyRemote` (cap-07). All four keep **node** objects whole, which is why v3's `tags` (a field
*inside* each node) survive even in a 1.0 tab, and a dropped `schemaVersion` is harmless, because
the server's idempotent upcaster puts it back. But the next format change might add a top-level
field, and then these four would silently delete it. Fix them now, while it costs nothing.

`web/src/lib/types.ts`: the new optional fields.

```ts
export interface StoryNode {
  id: string
  title: string
  text: string
  mediaUrl?: string | null
  x: number
  y: number
  tags?: string[]          // schemaVersion 3
}

/** The jsonb document stored in projects.doc */
export interface StoryDoc {
  schemaVersion?: number   // set by the server; the client never interprets it
  startNodeId: string | null
  nodes: StoryNode[]
  edges: StoryEdge[]
}
```

`web/src/lib/storyDoc.ts`: keep everything the server sent:

```ts
/** Accept `{}` or a partially filled document, and keep fields this build doesn't know. */
export function normalizeDoc(raw: unknown): StoryDoc {
  const d = (raw ?? {}) as Partial<StoryDoc>
  return {
    ...d,
    startNodeId: typeof d.startNodeId === 'string' ? d.startNodeId : null,
    nodes: Array.isArray(d.nodes) ? d.nodes : [],
    edges: Array.isArray(d.edges) ? d.edges : [],
  }
}
```

`web/src/modules/editor/reducer.ts`: `deleteNode` built a fresh object literal. Spread the doc first:

```ts
export function deleteNode(doc: StoryDoc, id: string): StoryDoc {
  if (!doc.nodes.some((n) => n.id === id)) return doc
  return {
    ...doc,
    startNodeId: doc.startNodeId === id ? null : doc.startNodeId,
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
  }
}
```

`web/src/modules/editor/merge.ts`, at the end of `mergeDocs`: start from *theirs* (the server's
newest document), so its top-level fields survive the merge:

```ts
  const doc: StoryDoc = { ...theirs, startNodeId, nodes, edges }
```

`web/src/modules/realtime/mergeRemote.ts`, the last line of `applyRemote`:

```ts
  return { ...doc, startNodeId: start, nodes, edges }
```

Add one test inside the `describe('storyReducer', …)` block of cap-06's `core.test.ts` (it already
has the `base` document) so this never regresses:

```ts
  it('keeps fields it does not know when deleting a scene', () => {
    const doc = { ...base, schemaVersion: 3, theme: 'dark' } as StoryDoc
    const next = storyReducer(doc, { type: 'deleteNode', id: 'b' })
    expect(next).toMatchObject({ schemaVersion: 3, theme: 'dark' })
  })
```

**5. The flag on the client.** `web/src/lib/features.ts`:

```ts
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api'

export type FeatureName = 'sceneTags'
export type Features = Partial<Record<FeatureName, boolean>>

export const featuresKey = ['features'] as const

/** Off while loading, on error, and for flags the server doesn't know: a flag only ever turns things ON. */
export function useFeature(name: FeatureName): boolean {
  const q = useQuery({
    queryKey: featuresKey,
    queryFn: () => apiFetch<Features>('/api/features'),
    staleTime: 60_000,
  })
  return q.data?.[name] === true
}
```

cap-05 clears the query cache on sign-out, so a different user never sees the previous user's flags.

**6. The tag editor.** `web/src/modules/editor/tags.ts`, which applies the same rules as the server:

```ts
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/
export const MAX_TAGS = 10

/** "Intro, Boss fight,intro" → ["intro", "boss-fight"] (trimmed, lower-case, unique, valid, at most 10). */
export function parseTags(input: string): string[] {
  const out: string[] = []
  for (const raw of input.split(',')) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-')
    if (TAG.test(tag) && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, MAX_TAGS)
}
```

`web/src/modules/editor/TagsField.tsx`. While you type, the text is a local *draft*; it becomes tags
on blur or Enter. Otherwise typing `a,` would immediately normalize the comma away.

```tsx
import { useState } from 'react'
import { TextField } from '../ui'
import { MAX_TAGS, parseTags } from './tags'

export interface TagsFieldProps {
  tags: string[]
  disabled: boolean
  onChange: (tags: string[]) => void
}

export function TagsField({ tags, disabled, onChange }: TagsFieldProps) {
  const [draft, setDraft] = useState(tags.join(', '))
  // Tags can change from outside (undo, a collaborator's patch): reset the draft when they do.
  // Compare the *content*, not the array: a collaborator editing this scene's text sends a new
  // node object with an equal tags array, and that must not wipe what you are typing.
  const key = tags.join(',')
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setDraft(tags.join(', '))
  }

  function commit() {
    const next = parseTags(draft)
    setDraft(next.join(', '))
    if (next.join(',') !== tags.join(',')) onChange(next)
  }

  return (
    <TextField
      label="Tags"
      hint={`Comma-separated, up to ${MAX_TAGS}. Letters, digits and dashes.`}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
    />
  )
}
```

`if (shownKey !== key) { … }` during render is React's documented way to "adjust state when a prop
changes" (react.dev, "You Might Not Need an Effect"), without an effect and without a frame that
shows stale text.

In `web/src/modules/editor/NodeInspector.tsx` (cap-06), add the imports:

```tsx
import { useFeature } from '../../lib/features'
import { TagsField } from './TagsField'
```

inside the component, next to the other hooks:

```tsx
  const sceneTags = useFeature('sceneTags')
```

and in the JSX, right after the "Media URL" field:

```tsx
      {sceneTags && (
        <TagsField tags={node.tags ?? []} disabled={readOnly} onChange={(tags) => update({ tags }, 'tags')} />
      )}
```

`NodePatch` is `Partial<Omit<StoryNode, 'id'>>`, so `{ tags }` type-checks without touching the
reducer. And because the flag hides only the **field**, users without the flag still load, keep
and save tags: `updateNode` spreads the existing node.

**7. Try it.**

```bash
npm --prefix web test            # the reducer test above passes
npm --prefix web run dev
```

Sign in as `ada`, open a story and select its **first** scene: the inspector shows **Tags**. Type `Intro, Boss fight` and press
Enter; it becomes `intro, boss-fight`, and autosave stores it. Now the flag-off user:

1. In a private window, sign in once as `ben`, so his user row exists (cap-04 can only share with
   people who have signed in).
2. Back as Ada, share the story with `ben@branchstory.test` as **editor**.
3. As Ben, open it: there is no Tags field. Edit the first scene's text and wait for autosave.
4. As Ada, reload: the tags are still there.

Check the stored row:

```bash
docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -c \
  "SELECT doc->'nodes'->0->'tags' AS tags, doc->>'schemaVersion' AS sv FROM projects ORDER BY updated_at DESC LIMIT 1"
```

```text
          tags          | sv
------------------------+----
 ["intro", "boss-fight"] | 3
```

Commit everything from Labs 1–3 and tag the release for Lab 4:

```bash
git add -A && git commit -m "feat: scene tags behind SceneTags flag, schemaVersion 3, upgrade-doc backfill"
git tag v1.1
```

- [ ] `GET /api/features` returns `{"sceneTags":true}` for Ada and `{"sceneTags":false}` for Ben (Development settings)
- [ ] The ten new unit tests pass, and the new reducer test passes in Vitest
- [ ] `normalizeDoc`, `deleteNode`, `mergeDocs` and `applyRemote` all keep top-level fields they don't know
- [ ] With the flag on, tags are normalized on Enter/blur and saved; with it off, the field is gone
- [ ] Ben (flag off) edits a tagged scene and the tags are still in the database afterwards
:::

## Rolling deploys with readiness gates

Kubernetes already does rolling updates (cap-10 set `maxUnavailable: 0, maxSurge: 1`). But "zero
downtime" only holds if every pod *says the truth* about when it can take traffic and when it is
going away. The pieces:

- **Readiness probe** (cap-10): a pod only gets traffic while `/health/ready` passes.
- **`maxSurge: 1, maxUnavailable: 0`**: start one new pod, wait until it's ready, only then stop an
  old one. Capacity never drops below `replicas`. This needs `replicas ≥ 2` to be meaningful for
  availability: with one replica, a crash of that pod is still an outage.
- **`minReadySeconds: 10`**: a new pod must stay ready for 10 seconds before it counts as
  available. That catches the pod that passes one probe and then crashes on its first real request.
- **`progressDeadlineSeconds: 180`**: if the rollout makes no progress for 3 minutes, the
  Deployment is marked `Progressing=False`, and `kubectl rollout status` exits non-zero, so cap-10's
  `deploy.sh` fails instead of hanging. (Kubernetes does *not* roll back by itself. Your script decides.)
- **A schema readiness check**: the API is only ready once every migration it was built with is
  applied. With the init-container migrator it always is. But if you later run migrations as a
  separate Job, or the migrator half-failed, this check stops a 1.1 pod from serving against a 1.0 schema.
- **Graceful shutdown with `preStop`**: when a pod is deleted, two things start **at the same
  time**. The kubelet begins stopping the container: it runs the `preStop` hook, then sends
  **SIGTERM** (the operating system's polite "please stop" signal). Meanwhile the control plane
  removes the pod from the Service's **endpoints** (the list of pod addresses that Traefik routes
  to). Traefik needs a moment to notice, so for a second or two it still sends requests to the
  leaving pod. Without a hook, the app would already be stopping and those requests fail. A
  5-second `preStop` sleep keeps the pod serving normally until the routers have caught up; only
  then does ASP.NET Core get SIGTERM, stop accepting connections and finish in-flight requests.

Kubernetes also has a feature literally called **readiness gates** (`spec.readinessGates`): extra
pod conditions set by *other* controllers, for example a cloud load balancer controller that marks
a pod ready only once the load balancer has registered it. You won't need it on kind, but you'll
see it in EKS and GKE manifests. It answers the same question: "is this pod really able to take
traffic?"

:::lab id=cap-11-lab4 xp=150
title: Roll 1.1 onto the kind cluster with zero failed requests, then flip the flag

You'll deploy v1.0 and v1.1 as real, tagged images, hammer the API during the rollout, rehearse a
rollback, run the backfill in the cluster, and release the feature by changing configuration.
You need the cluster from cap-10 (`./deploy/kind/up.sh`) and the `v1.0` / `v1.1` git tags.

**1. A schema readiness check.** `api/BranchStory.Api/Health/SchemaReadyCheck.cs`:

```csharp
using BranchStory.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BranchStory.Api.Health;

/// <summary>
/// Ready only when every migration this build ships with is applied. Once true it stays true
/// (migrations are never un-applied under a running pod), so the cost is one query per pod.
/// </summary>
public sealed class SchemaReadyCheck(BranchStoryDbContext db) : IHealthCheck
{
    private static volatile bool s_ready;

    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (s_ready) return HealthCheckResult.Healthy();
        var pending = (await db.Database.GetPendingMigrationsAsync(cancellationToken)).ToList();
        s_ready = pending.Count == 0;
        return s_ready
            ? HealthCheckResult.Healthy()
            : HealthCheckResult.Unhealthy($"waiting for migrations: {string.Join(", ", pending)}");
    }
}
```

Register it in `Program.cs`, next to cap-03's Postgres check:

```csharp
builder.Services.AddHealthChecks()
    .AddCheck<PostgresHealthCheck>("postgres", tags: ["ready"])
    .AddCheck<BranchStory.Api.Health.SchemaReadyCheck>("schema", tags: ["ready"]);
```

Commit it and move the tag (nothing has been deployed from `v1.1` yet):

```bash
git add -A && git commit -m "feat: schema readiness check" && git tag -f v1.1
```

**2. Harden the API Deployment.** Replace `deploy/k8s/base/api.yaml` (the Service is unchanged
from cap-10; the Deployment gains replicas, `minReadySeconds`, `progressDeadlineSeconds` and a
`preStop` hook):

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
  annotations:
    # SignalR negotiates over HTTP, then upgrades: with >1 replica both must hit the same pod.
    traefik.ingress.kubernetes.io/service.sticky.cookie: "true"
    traefik.ingress.kubernetes.io/service.sticky.cookie.name: bs_affinity
spec:
  selector: { app: api }
  ports: [{ name: http, port: 8080, targetPort: http }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2                       # a rolling update with 1 replica still has a single point of failure
  minReadySeconds: 10               # must stay ready 10 s before it counts as available
  progressDeadlineSeconds: 180      # no progress for 3 min → rollout status fails, deploy.sh exits 1
  selector: { matchLabels: { app: api } }
  strategy:
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
  template:
    metadata: { labels: { app: api } }
    spec:
      terminationGracePeriodSeconds: 40   # 5 s preStop + up to 30 s ASP.NET Core drain + slack
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      initContainers:
        - name: migrate
          image: branchstory/migrator
          imagePullPolicy: IfNotPresent
          # Two pods migrating at the same moment can still collide ("relation … already exists").
          # The failed init container restarts, finds the migrations applied, and the pod starts.
          args: ["--connection", "$(ConnectionStrings__BranchStory)"]
          env:
            - name: ConnectionStrings__BranchStory
              valueFrom: { secretKeyRef: { name: branchstory-secrets, key: ConnectionStrings__BranchStory } }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      containers:
        - name: api
          image: branchstory/api
          imagePullPolicy: IfNotPresent
          ports: [{ name: http, containerPort: 8080 }]
          envFrom: [{ configMapRef: { name: branchstory-config } }]
          env:
            - name: ConnectionStrings__BranchStory
              valueFrom: { secretKeyRef: { name: branchstory-secrets, key: ConnectionStrings__BranchStory } }
          lifecycle:
            # Keep serving while Traefik notices the pod is leaving (native sleep action, no shell needed).
            preStop: { sleep: { seconds: 5 } }
          startupProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 2
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /health/ready, port: http }
            periodSeconds: 5
            failureThreshold: 2
          resources:
            requests: { cpu: 100m, memory: 192Mi }
            limits: { memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes:
        - { name: tmp, emptyDir: {} }
```

Add the flag to the kind overlay's `configMapGenerator` literals in
`deploy/k8s/overlays/kind/kustomization.yaml`, **off**:

```yaml
configMapGenerator:
  - name: branchstory-config
    behavior: merge
    literals:
      - ASPNETCORE_ENVIRONMENT=Development   # local cluster: dev token issuer on
      - Features__SceneTags__Enabled=false
      - Features__SceneTags__Percent=0
```

(`__` is how environment variables spell the `:` of configuration paths.) Commit both files. They
are deployment configuration, not part of an image, so no tag move is needed.

**3. Build any tagged release into kind.** `deploy/kind/release.sh`:

```bash
#!/usr/bin/env bash
# Usage: deploy/kind/release.sh <git-tag>
# Builds that tag's four images from a clean checkout and loads them into the kind cluster as
# local/branchstory-<name>:<tag>, the naming deploy/ci/deploy.sh expects with REGISTRY=local.
set -euo pipefail
TAG=$1
CLUSTER=branchstory
cd "$(dirname "$0")/../.."
SRC=$(mktemp -d)
git worktree add --detach "$SRC" "$TAG" > /dev/null
trap 'git worktree remove --force "$SRC"' EXIT

docker build -f "$SRC/api/Dockerfile" --target runtime  -t "local/branchstory-api:$TAG"      "$SRC"
docker build -f "$SRC/api/Dockerfile" --target migrator -t "local/branchstory-migrator:$TAG" "$SRC"
docker build -f "$SRC/worker/Dockerfile"                 -t "local/branchstory-worker:$TAG"   "$SRC"
docker build -f "$SRC/web/Dockerfile"                    -t "local/branchstory-web:$TAG"      "$SRC"
kind load docker-image --name "$CLUSTER" \
  "local/branchstory-api:$TAG" "local/branchstory-migrator:$TAG" \
  "local/branchstory-worker:$TAG" "local/branchstory-web:$TAG"
echo "loaded $TAG"
```

A `git worktree` is a second checkout of the same repository in another folder. Building from it
means the images contain exactly what the tag says, not whatever is uncommitted in your working copy.

**4. A request hammer.** `deploy/kind/hammer.sh` reads one project ten times a second and prints
every failure:

```bash
#!/usr/bin/env bash
# Usage: deploy/kind/hammer.sh [base-url]. Ctrl+C prints the totals.
set -euo pipefail
BASE=${1:-http://localhost:8088}
TOKEN=$(curl -fsS -X POST "$BASE/api/dev/token" -H 'content-type: application/json' \
  -d '{"username":"hammer"}' | jq -r .accessToken)
AUTH=(-H "Authorization: Bearer $TOKEN")
ID=$(curl -fsS "${AUTH[@]}" "$BASE/api/projects" | jq -r '.[0].id // empty')
[ -n "$ID" ] || ID=$(curl -fsS "${AUTH[@]}" -X POST "$BASE/api/projects" \
  -H 'content-type: application/json' -d '{"title":"Hammer"}' | jq -r .id)

ok=0; failed=0
trap 'echo; echo "ok=$ok failed=$failed"; exit 0' INT
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${AUTH[@]}" "$BASE/api/projects/$ID" || true)
  if [ "$code" = 200 ]; then ok=$((ok + 1)); else failed=$((failed + 1)); echo "$(date +%T) HTTP $code"; fi
  sleep 0.1
done
```

```bash
chmod +x deploy/kind/release.sh deploy/kind/hammer.sh
```

**5. Baseline: deploy 1.0 as a tagged release.**

```bash
deploy/kind/release.sh v1.0
REGISTRY=local deploy/ci/deploy.sh deploy/k8s/overlays/kind v1.0
kubectl -n branchstory get deploy -o wide        # IMAGES: local/branchstory-*:v1.0, api READY 2/2
```

Make some 1.0 data: sign in at http://localhost:8088, create two stories and add a few scenes.

**6. The rollout, under fire.** Three terminals:

```bash
# terminal 1
deploy/kind/hammer.sh
# terminal 2
kubectl -n branchstory get pods -l app=api -w
# terminal 3
deploy/kind/release.sh v1.1
REGISTRY=local deploy/ci/deploy.sh deploy/k8s/overlays/kind v1.1
```

In terminal 2 you see the surge: a third pod appears, goes through `Init:0/1` (the migrator applies
`DocSchemaVersionExpand` and `DocSchemaVersionIndex`) and `Running 0/1`, becomes `1/1`, waits 10 s
(`minReadySeconds`), and only then an old pod goes to `Terminating`, then the same again for the
second one. When `deploy.sh` prints `deployed v1.1`, stop the hammer:

```text
^C
ok=1287 failed=0
```

Check what ran. `-l app=api` reads the init-container log of **every** api pod: only the first 1.1
pod applied the migrations, the second one found nothing to do.

```bash
kubectl -n branchstory logs -l app=api -c migrate --prefix | grep -i applying
kubectl -n branchstory exec -i statefulset/postgres -- psql -U branchstory -d branchstory \
  -c "SELECT count(*) FILTER (WHERE doc_schema_version IS NULL) AS old, count(*) AS total FROM projects"
```

The stories you created under 1.0 are still `old`: nothing rewrote them, and 1.1 reads them fine.

:::warn title="If you see failures"
A handful of `HTTP 502` / `000` lines exactly when an old pod terminates means the `preStop` hook
isn't there (check `kubectl -n branchstory get deploy api -o yaml | grep -A2 preStop`). The native
`sleep` action needs Kubernetes 1.30 or newer; on an older kind node image, use
`preStop: { exec: { command: ["sleep", "5"] } }` instead. Failures while a *new* pod starts mean
it got traffic before it was ready: check that `/health/ready` really queries the database.
:::

**7. Rehearse the rollback while it is still free.** The flag is off, so no document contains a
real tag yet. Rolling back to 1.0 loses nothing:

```bash
time REGISTRY=local deploy/ci/deploy.sh deploy/k8s/overlays/kind v1.0
deploy/ci/smoke.sh http://localhost:8088
REGISTRY=local deploy/ci/deploy.sh deploy/k8s/overlays/kind v1.1
```

1.0 runs happily against the expanded schema: it never mentions `doc_schema_version`, and the
nullable column doesn't bother its `INSERT`s. Write down the `time`.

**8. Run the backfill in the cluster**, now that no 1.0 pod is left:

```bash
kubectl -n branchstory rollout status deployment/api deployment/worker   # both complete, all v1.1
PSQL="kubectl -n branchstory exec -i statefulset/postgres -- psql -U branchstory -d branchstory"
$PSQL < deploy/ops/backfill-v3.sql
$PSQL < deploy/ops/backfill-v3-progress.sql
```

Repeat the progress query until `remaining` is `0`. Keep the `v1.1` image tags that `deploy.sh`
wrote into the overlay for the rest of this lesson; Lab 5 changes them to `v1.2`.

**9. Release the feature with configuration.** In the overlay, turn the flag on for yourself first:

```yaml
      - Features__SceneTags__Enabled=true
      - Features__SceneTags__Percent=0
      - Features__SceneTags__Users__0=ada@branchstory.test
```

```bash
deploy/kind/hammer.sh &                         # in the background this time
kubectl apply -k deploy/k8s/overlays/kind       # new ConfigMap hash → api and worker roll
kubectl -n branchstory rollout status deployment/api
kill -INT %1                                    # ok=… failed=0
```

Sign in as `ada` at http://localhost:8088: the Tags field is there. Sign in as anyone else: it
isn't. Then go to `Percent=50` and `Percent=100` the same way. To **kill** the feature, set
`Enabled=false` and apply: the field disappears in about a minute, and the tags stay stored.

- [ ] `deploy.sh … v1.1` completes with the hammer reporting `failed=0`, and the watch shows a surge pod becoming ready before each old pod terminates
- [ ] The migrate init container log of one 1.1 pod (the first to start) lists `DocSchemaVersionExpand` and `DocSchemaVersionIndex`; the other one found nothing left to apply
- [ ] A rollback to `v1.0` and forward to `v1.1` both pass `smoke.sh`, with their times written down
- [ ] After the in-cluster backfill, the progress query reports `remaining = 0`
- [ ] Flipping the flag by ConfigMap rolls the API with `failed=0`, and only allowlisted users see Tags until `Percent` is raised
:::

## The rollback plan

A **rollback plan** says, for every stage of the release, *how* to go back and *what it costs*.
The key idea is the **rollback floor**: the oldest release you can still safely return to. It
moves forward as the release progresses, and you should always know where it is.

| Stage | How to undo it | Data risk | Rollback floor |
|---|---|---|---|
| 1.1 rolling out | `deploy.sh … v1.0` (or `rollout undo` to stop the bleeding) | none: the expand schema is invisible to 1.0 | 1.0 |
| 1.1 deployed, flag off | `deploy.sh … v1.0` | none (no real tags exist). 1.0 saves leave `doc_schema_version` stale, so re-run the backfill with a new run label after rolling forward | 1.0 |
| Backfill running | pause it (`run_after = 'infinity'`); fix; resume. If you must go back to 1.0, pause **first**: a 1.0 worker dead-letters queued `upgrade-doc` jobs as `unknown kind` | none: rewritten rows are v3, which 1.1 reads; 1.0 still reads them too (it ignores `tags`). After rolling forward, re-enqueue with a new run label | 1.0 |
| Flag on for anyone | **flag off** (a config change, about a minute). Don't roll the code back. | Rolling back to 1.0 now **drops tags** on every save, because 1.0 rebuilds documents without them | **1.1** |
| 1.2 (contract) deployed | `deploy.sh … v1.1` | none: 1.1 always writes `doc_schema_version` | **1.1**: 1.0's `INSERT INTO projects` fails the `NOT NULL` |
| Some day, v4 documents | — | 1.2 throws `StoryDocTooNewException` on v4 documents (by design: it refuses to downgrade) | the release that first *reads* v4 |

That last row shows the general rule for **non-additive** document changes: ship the **reader**
first (a release that understands v4 but still writes v3), wait until it is everywhere, then ship
the **writer**. Then every rollback lands on a release that can read everything in the database.
v3 got away with one release only because the change was additive *and* the flag kept real tags out
of the database until the floor had moved.

:::pro title="Roll forward by default"
Mature teams roll back **code** quickly and freely while nothing irreversible has happened, and
otherwise **roll forward**: fix and ship 1.1.1 in minutes through the same pipeline. That only works
if the pipeline is fast and trusted (cap-09, cap-10). EF Core migrations have `Down()` methods, but
production teams rarely run them. Undoing a migration under live traffic is a schema change of its
own, with its own risks, and a `Down()` that drops a column also drops the data written since. The
expand/contract rhythm exists so that you never *need* a down-migration.
:::

:::quiz id=cap-11-q8 xp=15
The flag has been at 30 % for two days when error rates on `PUT …/doc` rise. Someone suggests
`deploy.sh … v1.0`. What's the right first move?
- [ ] Roll back to 1.0: it's rehearsed and takes two minutes
- [x] Turn the flag off (or back to the allowlist) and investigate on 1.1; rolling back to 1.0 now would strip tags from every story it saves
- [ ] Run the 1.1 migrations' `Down()` methods, then roll back to 1.0
- [ ] Scale the worker to zero, because the backfill is probably the cause
> With real tags in the database, 1.0 is below the rollback floor: it rebuilds documents without `tags`, so every save through it deletes users' work. The flag is the cheap, fast, data-safe lever, and is exactly what it was built for. If the errors persist with the flag off, the cause is in 1.1's always-on code: fix forward (1.1.1). `Down()` would drop the column under live traffic and change nothing about the tag-stripping problem. Blaming the backfill without evidence is a guess; the progress and failure queries tell you in seconds whether it is even running.
:::

:::lab id=cap-11-lab5 xp=120
title: Contract — make the new shape a database rule (release 1.2)

Days later: the backfill has reported `remaining = 0` for a while, every pod runs 1.1, and the flag
is at 100 %. Time to remove the training wheels.

**1. The model.** In `Entities.cs`, the property becomes non-nullable:

```csharp
    /// <summary>Mirrors doc.schemaVersion. NOT NULL and >= 3 since the 1.2 contract migration.</summary>
    public int DocSchemaVersion { get; set; } = StoryDoc.CurrentSchemaVersion;
```

In `ProjectConfig.cs`, delete the `ix_projects_doc_schema_version_null` index from Lab 1 and add
the check constraint next to the existing one:

```csharp
        b.ToTable(t =>
        {
            t.HasCheckConstraint("ck_projects_version_positive", "version > 0");
            t.HasCheckConstraint("ck_projects_doc_schema_version", "doc_schema_version >= 3");
        });
```

In `SaveDoc`, `.SetProperty(p => p.DocSchemaVersion, StoryDoc.CurrentSchemaVersion)` still compiles
unchanged.

**2. Generate the migration, and read it before you trust it.**

```bash
dotnet ef migrations add DocSchemaVersionContract --project api/BranchStory.Data --output-dir Migrations
dotnet ef migrations script DocSchemaVersionIndex DocSchemaVersionContract --project api/BranchStory.Data
```

EF Core's scaffold is correct for an empty table and dangerous for a live one:

```text
START TRANSACTION;
DROP INDEX ix_projects_doc_schema_version_null;
UPDATE projects SET doc_schema_version = 0 WHERE doc_schema_version IS NULL;
ALTER TABLE projects ALTER COLUMN doc_schema_version SET NOT NULL;
ALTER TABLE projects ALTER COLUMN doc_schema_version SET DEFAULT 0;
ALTER TABLE projects ADD CONSTRAINT ck_projects_doc_schema_version CHECK (doc_schema_version >= 3);
…
COMMIT;
```

Four problems: the `UPDATE … = 0` *invents* a version for unfinished rows (and then the check would
reject them anyway); `SET NOT NULL` and `ADD CONSTRAINT` each scan two million rows while the
transaction holds ACCESS EXCLUSIVE; a plain `DROP INDEX` blocks too; and a default of `0` is a lie
for any future insert.

**3. Replace the generated `Up` method** in `Migrations/*_DocSchemaVersionContract.cs` (leave
`Down` and the `.Designer.cs` file as generated):

```csharp
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Hand-edited: EF's scaffold would have run "UPDATE … SET doc_schema_version = 0" and
            // then SET NOT NULL + ADD CHECK inside one transaction, holding ACCESS EXCLUSIVE
            // during two full-table scans. Every Sql() below runs outside a transaction and can
            // be re-run safely if the deploy fails halfway.

            // 0. Refuse to contract while the backfill is unfinished (a clear error, no lock taken).
            migrationBuilder.Sql("""
                DO $$
                DECLARE remaining bigint;
                BEGIN
                    SELECT count(*) INTO remaining FROM projects
                    WHERE doc_schema_version IS DISTINCT FROM 3 OR doc->>'schemaVersion' IS DISTINCT FROM '3';
                    IF remaining > 0 THEN
                        RAISE EXCEPTION 'backfill not finished: % project(s) below schemaVersion 3', remaining;
                    END IF;
                END $$;
                """, suppressTransaction: true);

            // Give up after 5 s instead of queueing behind a long transaction (and blocking
            // every query that queues up behind us).
            migrationBuilder.Sql("SET lock_timeout = '5s';", suppressTransaction: true);

            // 1. NOT NULL without the long lock: add an unchecked CHECK (instant), validate it under
            //    SHARE UPDATE EXCLUSIVE (reads and writes continue), then SET NOT NULL, which
            //    Postgres 12+ proves from the validated check instead of scanning the table.
            migrationBuilder.Sql("""
                ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_projects_doc_schema_version_nn;
                ALTER TABLE projects ADD CONSTRAINT ck_projects_doc_schema_version_nn
                    CHECK (doc_schema_version IS NOT NULL) NOT VALID;
                """, suppressTransaction: true);
            migrationBuilder.Sql("ALTER TABLE projects VALIDATE CONSTRAINT ck_projects_doc_schema_version_nn;",
                suppressTransaction: true);
            migrationBuilder.Sql("ALTER TABLE projects ALTER COLUMN doc_schema_version SET NOT NULL;",
                suppressTransaction: true);
            migrationBuilder.Sql("ALTER TABLE projects DROP CONSTRAINT ck_projects_doc_schema_version_nn;",
                suppressTransaction: true);

            // 2. The rule the model declares (HasCheckConstraint), added the same two-step way.
            migrationBuilder.Sql("""
                ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_projects_doc_schema_version;
                ALTER TABLE projects ADD CONSTRAINT ck_projects_doc_schema_version
                    CHECK (doc_schema_version >= 3) NOT VALID;
                """, suppressTransaction: true);
            migrationBuilder.Sql("ALTER TABLE projects VALIDATE CONSTRAINT ck_projects_doc_schema_version;",
                suppressTransaction: true);

            // 3. The backfill index has done its job.
            migrationBuilder.Sql("DROP INDEX CONCURRENTLY IF EXISTS ix_projects_doc_schema_version_null;",
                suppressTransaction: true);
            migrationBuilder.Sql("RESET lock_timeout;", suppressTransaction: true);
        }
```

Why each detail:

- **`suppressTransaction: true`** runs a statement on its own, outside EF's migration transaction.
  Inside one transaction, the instant `ADD CONSTRAINT … NOT VALID` would keep its ACCESS
  EXCLUSIVE lock until `COMMIT`, through the whole `VALIDATE` scan, which defeats the point.
- **Re-runnable steps.** Without a transaction, a failure leaves the earlier steps applied, and the
  migration isn't recorded as done. The next deploy runs it again, so every step must survive that:
  `DROP CONSTRAINT IF EXISTS` before `ADD`, `DROP INDEX … IF EXISTS`. (`SET NOT NULL` on a column
  that already is NOT NULL is a no-op.)
- **The `IS NOT NULL` check comes first**, because `CHECK (doc_schema_version >= 3)` lets NULLs
  through (in SQL, `NULL >= 3` is unknown, and a check only rejects *false*).
- **The guard in step 0** turns "you forgot the backfill" into a readable error *before* any lock
  is taken. The deploy fails, the old pods keep serving, and nothing is half-changed.

**4. Try the guard locally first.** With the compose database from Labs 1–2:

```bash
PSQL="docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -d branchstory"
$PSQL -c "UPDATE projects SET doc_schema_version = NULL WHERE id = (SELECT id FROM projects LIMIT 1)"
dotnet run --project api/BranchStory.Api      # MigrateOnStartup in Development
```

The API stops at startup. First EF Core logs a warning that the migration operation "cannot be
executed in a transaction" and may be left partially applied. That is expected: it is exactly
what `suppressTransaction: true` asked for, and why every step is re-runnable. Then:

```text
Npgsql.PostgresException (0x80004005): P0001: backfill not finished: 1 project(s) below schemaVersion 3
```

Finish the backfill (`backfill-v3.sql` with the run label bumped to `r2`, the worker running),
start the API again, and check:

```bash
$PSQL -c '\d projects' | grep -E 'doc_schema_version|ck_projects_doc|ix_projects_doc'
```

```text
 doc_schema_version | integer                  |           | not null |
    "ck_projects_doc_schema_version" CHECK (doc_schema_version >= 3)
```

No `_nn` helper constraint and no partial index are left.

**5. Prove the new floor.** 1.0 doesn't know the column, so its inserts now fail. That's exactly
why it is no longer a rollback target:

```bash
$PSQL -c "INSERT INTO projects (id, owner_id, title, doc, version, created_at, updated_at)
          SELECT gen_random_uuid(), id, 'as 1.0 would', '{}', 1, now(), now() FROM users LIMIT 1"
```

```text
ERROR:  null value in column "doc_schema_version" of relation "projects" violates not-null constraint
```

**6. Ship it.** Commit, `git tag v1.2`, then:

```bash
deploy/kind/hammer.sh &
deploy/kind/release.sh v1.2
REGISTRY=local deploy/ci/deploy.sh deploy/k8s/overlays/kind v1.2
kill -INT %1                                                    # failed=0
kubectl -n branchstory logs -l app=api -c migrate --prefix | grep -i DocSchemaVersionContract
```

Finally, update `docs/adr/` with a short ADR (cap-01's template): "Document schema changes use
schemaVersion + upcasters; database changes use expand → deploy → contract; rollback floor
recorded per release."

- [ ] The hand-edited contract migration fails with `backfill not finished` while a NULL row exists, and leaves the table unlocked and usable
- [ ] After the backfill, it applies; `\d projects` shows `doc_schema_version … not null` and `ck_projects_doc_schema_version`, and no leftover `_nn` constraint or partial index
- [ ] An `INSERT` without `doc_schema_version` (what 1.0 would do) is rejected
- [ ] `deploy.sh … v1.2` on kind completes with the hammer reporting `failed=0`
:::

:::quiz id=cap-11-q9 xp=15
Why does the contract migration use `suppressTransaction: true` for its `ALTER TABLE` statements,
even though running a migration in one transaction is normally the safer choice?
- [ ] EF Core can't run `ALTER TABLE` inside a transaction on Postgres
- [x] Locks are held until the transaction ends, so the instant `ADD CONSTRAINT … NOT VALID` would keep ACCESS EXCLUSIVE through the long `VALIDATE` scan, blocking all traffic
- [ ] Without a transaction the migration runs on a faster connection
- [ ] It lets the migration skip writing to `__EFMigrationsHistory`
> Postgres DDL is fully transactional, and that is the problem here: every lock taken inside a transaction is released only at `COMMIT`. The two-step NOT VALID / VALIDATE trick only helps if each step commits on its own. The price is that a failure leaves the earlier steps applied, which is why every statement is written to be re-runnable and the guard runs first. The history row is still written once the migration completes.
:::

:::cards id=cap-11-cards1 xp=20 title="Changing a live system"
Q: What is the mixed-version window?
A: The time during and after a rollout when old and new code (pods, browser tabs, workers) run
   together against the same data. Every change must be correct inside it.
Q: `schemaVersion` vs `projects.version`?
A: `schemaVersion` names the document's *format* (1, 2, 3) and picks the upgrade steps.
   `version` counts *saves* of one story and guards against lost updates (409/412).
Q: What does a missing `schemaVersion` mean?
A: Version 1: the document was written before the field existed. Never "current".
Q: Four rules for upcasters?
A: Idempotent, keep unknown fields, never downgrade (refuse newer versions), pure (JSON in, JSON out).
Q: Expand → deploy → contract in one sentence each?
A: Expand: add only what old code can ignore. Deploy: new code reads old and new, writes new,
   and the backfill runs. Contract: remove the old path once nothing uses it.
Q: How do you add NOT NULL to a big table without blocking it?
A: `ADD CONSTRAINT … CHECK (x IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT` (weak lock),
   then `SET NOT NULL` (Postgres 12+ skips the scan), then drop the helper check. Each in its own transaction.
Q: Why `SET lock_timeout` before DDL?
A: A waiting ACCESS EXCLUSIVE request blocks every query queued behind it. A timeout makes the
   migration fail fast instead of stalling the whole API.
Q: Why must a backfill not bump `projects.version`?
A: It changes representation, not content. A bump would give every open editor a 409 on the next
   autosave. Guard the write with `WHERE version = @read` instead.
Q: How is the BranchStory backfill paced?
A: One `upgrade-doc` job per project, with `run_after = now() + n × 50 ms`, so user publishes sort
   first and the database sees about 20 rewrites per second.
Q: Why a stable hash for percentage rollouts?
A: Users must land in the same bucket on every pod and after every restart. `string.GetHashCode`
   is randomized per process; SHA-256 of `flag:userId` isn't.
Q: What do `minReadySeconds` and `progressDeadlineSeconds` do?
A: A new pod must stay ready that long before it counts as available; a rollout without progress
   for the deadline is marked failed, so `rollout status` (and the deploy script) exits non-zero.
Q: What is the rollback floor?
A: The oldest release you can still safely return to. It moves forward when data only newer code
   understands appears (flag on) or when the schema stops accepting old code (contract).
:::

## Recap

- From 1.0 on, every change meets **live data and old code**. List the combinations in the
  mixed-version window (old code + new schema, new code + old data, old code + new data) and design for each.
- The jsonb document now carries a **`schemaVersion`** (missing means 1). **Upcasters** bring any
  stored version up to the current one on read, in the API through a `JsonConverter`, in the worker
  through the same linked source file (compiled `internal` there, so the two copies never clash). They are idempotent, keep unknown fields, are pure, and refuse
  documents from a newer release.
- Database changes follow **expand → deploy → contract**: a nullable `doc_schema_version` and a
  partial index built `CONCURRENTLY` in 1.1; `NOT NULL` and `CHECK (>= 3)` in 1.2, added with
  `NOT VALID` + `VALIDATE`, `lock_timeout`, re-runnable steps and a guard that refuses to contract early.
  Read every scaffolded migration: EF Core's default is written for empty tables.
- **API changes are additive**: new response fields, optional request fields, new endpoints.
  Renames go through both-names-then-remove. Clients must round-trip fields they don't know
  (`normalizeDoc`, `deleteNode`, `mergeDocs` and `applyRemote` were fixed for exactly that).
- The **backfill** runs as paced, idempotent `upgrade-doc` jobs on the cap-08 worker, starts only
  after the rollout is complete, never bumps `version`, loses races to real saves, and has a
  progress query, a failure list and a pause switch.
- A **feature flag** (kill switch, allowlist, stable percentage) dark-launches the tag editor. Flags
  gate experiences, never data formats, and every flag gets an owner and a removal date.
- **Rolling deploys** are only zero-downtime with honest pods: ≥ 2 replicas, `maxUnavailable: 0`,
  readiness that includes "my migrations are applied", `minReadySeconds`, `progressDeadlineSeconds`
  and a `preStop` sleep. Prove it with a request hammer, not with hope.
- Keep a **rollback plan** with a **rollback floor** per stage. Roll code back freely while nothing
  irreversible has happened; after that, use the flag or roll forward.
