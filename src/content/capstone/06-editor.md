---
id: cap-06
title: "The Graph Editor: Reducers, Autosave & Conflicts"
level: expert
minutes: 330
xp: 250
summary: Build the branching-story editor on a pure reducer — validation, undo/redo, debounced autosave, optimistic cache updates and a reload / overwrite / merge dialog for 409 conflicts.
---

This is the heart of BranchStory: a canvas of **scenes** (nodes) connected by **choices**
(edges), saved as one jsonb document with a `version`. It is also where most real editors go
wrong. They scatter `setState` calls through twenty components, lose edits on a flaky network,
and silently overwrite a colleague's work.

We avoid all three with a small set of ideas:

1. **The document is a value.** All edits go through one *pure* reducer `(doc, action) → doc`. No
   mutation, no I/O, no `Date.now()`, no random ids inside it, so it is trivially testable.
2. **History wraps the reducer.** Undo/redo stores *snapshots* of earlier values. Because the
   reducer never mutates, sharing references between snapshots is safe and cheap.
3. **Saving is a side effect at the edge.** A hook watches the document's *revision*, debounces,
   and sends `PUT /doc` with `expectedVersion`.
4. **A 409 is a normal outcome, not a crash.** The user chooses reload, overwrite or a
   three-way merge.

```text
 user input ──► dispatch(action) ──► historyReducer ──► storyReducer (pure)
                                        │  past / present / future, rev
                                        ▼
                          useAutosave(present, rev) ── debounce ──► PUT /doc {expectedVersion}
                                        │                               │
                                        │                 200 {version} │ 409 {currentVersion}
                                        ▼                               ▼
                               "Saved · v8"                  ConflictDialog: reload / overwrite / merge
```

## The document model

The shapes come from `lib/types.ts` (cap-05):

```ts
interface StoryNode { id: string; title: string; text: string; mediaUrl?: string | null; x: number; y: number }
interface StoryEdge { id: string; from: string; to: string; label: string }
interface StoryDoc  { startNodeId: string | null; nodes: StoryNode[]; edges: StoryEdge[] }
```

Ids are created **by the caller** (`crypto.randomUUID()`) and passed in the action. That keeps the
reducer deterministic: the same action on the same document always gives the same result, which
is exactly what you need for tests, undo, and — in cap-07 — replaying a collaborator's changes.

:::pro title="Why not a graph library from day one?"
React Flow and friends are excellent, and a real product would likely adopt one for zoom, pan,
minimap and edge routing. But the *document*, the *reducer* and the *save protocol* are yours
regardless of the rendering library. Build those first with a plain canvas; swapping the view
later is then a contained change.
:::

:::challenge id=cap-06-c1 lang=ts xp=50
title: addNode and connect
Implement two cases of `storyReducer(doc, action)`. It must be **pure**: never mutate `doc`,
return a new object when something changes and the **same** object when nothing does.

- `addNode`: append `action.node`. If the document has no start yet (`startNodeId === null`), the
  new node becomes the start. If a node with that id already exists, do nothing.
- `connect`: append `action.edge` only if **both** `from` and `to` are existing node ids, and no edge
  with the same `id` exists, and there isn't already an edge with the same `from`, `to` **and**
  `label` (a double-click must not create two identical choices). Otherwise do nothing.

hint: `doc.nodes.some((n) => n.id === id)` answers "does it exist?"
hint: Spread to copy: `{ ...doc, nodes: [...doc.nodes, action.node] }`
hint: `doc.startNodeId ?? action.node.id` keeps an existing start.

```ts setup
type StoryNode = { id: string; title: string; text: string; x: number; y: number }
type StoryEdge = { id: string; from: string; to: string; label: string }
type StoryDoc = { startNodeId: string | null; nodes: StoryNode[]; edges: StoryEdge[] }
type StoryAction =
  | { type: 'addNode'; node: StoryNode }
  | { type: 'connect'; edge: StoryEdge }
```

```ts starter
export function storyReducer(doc: StoryDoc, action: StoryAction): StoryDoc {
  switch (action.type) {
    case 'addNode':
      // TODO
      return doc
    case 'connect':
      // TODO
      return doc
  }
}
```

```ts solution
export function storyReducer(doc: StoryDoc, action: StoryAction): StoryDoc {
  switch (action.type) {
    case 'addNode': {
      if (doc.nodes.some((n) => n.id === action.node.id)) return doc
      return {
        ...doc,
        nodes: [...doc.nodes, action.node],
        startNodeId: doc.startNodeId ?? action.node.id,
      }
    }
    case 'connect': {
      const { edge } = action
      const exists = (id: string) => doc.nodes.some((n) => n.id === id)
      if (!exists(edge.from) || !exists(edge.to)) return doc
      const duplicate = doc.edges.some(
        (e) => e.id === edge.id || (e.from === edge.from && e.to === edge.to && e.label === edge.label),
      )
      if (duplicate) return doc
      return { ...doc, edges: [...doc.edges, edge] }
    }
  }
}
```

```ts tests
const scene = (id: string): StoryNode => ({ id, title: id, text: '', x: 0, y: 0 })
const blank: StoryDoc = { startNodeId: null, nodes: [], edges: [] }
const twoScenes = (): StoryDoc => ({ startNodeId: 'a', nodes: [scene('a'), scene('b')], edges: [] })

test('addNode appends the node', () => {
  const d = storyReducer(twoScenes(), { type: 'addNode', node: scene('c') })
  expect(d.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
})
test('the first node becomes the start', () => {
  expect(storyReducer(blank, { type: 'addNode', node: scene('a') }).startNodeId).toBe('a')
})
test('a later node does not move the start', () => {
  expect(storyReducer(twoScenes(), { type: 'addNode', node: scene('c') }).startNodeId).toBe('a')
})
test('adding an existing id returns the same object', () => {
  const d = twoScenes()
  expect(storyReducer(d, { type: 'addNode', node: scene('a') })).toBe(d)
})
test('addNode does not mutate the input', () => {
  storyReducer(blank, { type: 'addNode', node: scene('a') })
  expect(blank.nodes).toHaveLength(0)
  expect(blank.startNodeId).toBeNull()
})
test('connect adds a choice between existing scenes', () => {
  const d = storyReducer(twoScenes(), { type: 'connect', edge: { id: 'e1', from: 'a', to: 'b', label: 'Go' } })
  expect(d.edges).toEqual([{ id: 'e1', from: 'a', to: 'b', label: 'Go' }])
})
test('connect allows a self-loop', () => {
  const d = storyReducer(twoScenes(), { type: 'connect', edge: { id: 'e1', from: 'a', to: 'a', label: 'Try again' } })
  expect(d.edges).toHaveLength(1)
})
test('connect ignores a missing endpoint', () => {
  const d = twoScenes()
  expect(storyReducer(d, { type: 'connect', edge: { id: 'e1', from: 'a', to: 'ghost', label: 'Go' } })).toBe(d)
  expect(storyReducer(d, { type: 'connect', edge: { id: 'e1', from: 'ghost', to: 'b', label: 'Go' } })).toBe(d)
})
test('connect ignores a duplicate id or an identical choice', () => {
  const d = storyReducer(twoScenes(), { type: 'connect', edge: { id: 'e1', from: 'a', to: 'b', label: 'Go' } })
  expect(storyReducer(d, { type: 'connect', edge: { id: 'e1', from: 'b', to: 'a', label: 'Back' } })).toBe(d)
  expect(storyReducer(d, { type: 'connect', edge: { id: 'e2', from: 'a', to: 'b', label: 'Go' } })).toBe(d)
  expect(storyReducer(d, { type: 'connect', edge: { id: 'e3', from: 'a', to: 'b', label: 'Run' } }).edges).toHaveLength(2)
})
```
:::

:::challenge id=cap-06-c2 lang=ts xp=50
title: deleteNode cascades
Write `deleteNode(doc, id)`. Removing a scene must also remove **every choice that touches it**
(incoming, outgoing and self-loops) — otherwise the document holds edges pointing at nothing. If
the deleted scene was the start, `startNodeId` becomes `null`. Unknown id → return the same
object. Keep the order of everything that remains, and don't mutate the input.

hint: `filter` twice: once for nodes, once for edges where `e.from !== id && e.to !== id`.

```ts setup
type StoryNode = { id: string; title: string; text: string; x: number; y: number }
type StoryEdge = { id: string; from: string; to: string; label: string }
type StoryDoc = { startNodeId: string | null; nodes: StoryNode[]; edges: StoryEdge[] }
```

```ts starter
export function deleteNode(doc: StoryDoc, id: string): StoryDoc {
  return { ...doc, nodes: doc.nodes.filter((n) => n.id !== id) }
}
```

```ts solution
export function deleteNode(doc: StoryDoc, id: string): StoryDoc {
  if (!doc.nodes.some((n) => n.id === id)) return doc
  return {
    startNodeId: doc.startNodeId === id ? null : doc.startNodeId,
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
  }
}
```

```ts tests
const sc = (id: string): StoryNode => ({ id, title: id, text: '', x: 0, y: 0 })
const ch = (id: string, from: string, to: string): StoryEdge => ({ id, from, to, label: id })
const graph = (): StoryDoc => ({
  startNodeId: 'a',
  nodes: [sc('a'), sc('b'), sc('c')],
  edges: [ch('ab', 'a', 'b'), ch('bc', 'b', 'c'), ch('ca', 'c', 'a'), ch('bb', 'b', 'b'), ch('ac', 'a', 'c')],
})

test('removes the scene', () => {
  expect(deleteNode(graph(), 'b').nodes.map((n) => n.id)).toEqual(['a', 'c'])
})
test('removes incoming, outgoing and self-loop choices', () => {
  expect(deleteNode(graph(), 'b').edges.map((e) => e.id)).toEqual(['ca', 'ac'])
})
test('deleting the start clears startNodeId', () => {
  expect(deleteNode(graph(), 'a').startNodeId).toBeNull()
})
test('deleting another scene keeps the start', () => {
  expect(deleteNode(graph(), 'c').startNodeId).toBe('a')
})
test('unknown id returns the same object', () => {
  const g = graph()
  expect(deleteNode(g, 'zzz')).toBe(g)
})
test('the input is not mutated', () => {
  const g = graph()
  deleteNode(g, 'b')
  expect(g.nodes).toHaveLength(3)
  expect(g.edges).toHaveLength(5)
})
```
:::

## Is the story playable?

A story the player can't finish is a bug the author can't see. The editor validates on every
change (it is a pure function of the document, so `useMemo` makes it free) and lists problems
next to the canvas. The publish pipeline in cap-08 runs the **same rules on the server** before
rendering, because a client check is advice, not enforcement.

:::challenge id=cap-06-c3 lang=ts xp=60
title: Validate the story graph
Write `validateStory(doc)` returning a list of issues `{ code, id?, message }` (any non-empty `message`):

1. For every edge whose `from` **or** `to` is not an existing node: `'dangling-edge'` with the edge id.
2. For every other edge whose label is empty or only whitespace: `'empty-label'` with the edge id.
3. If `startNodeId` is `null` or not an existing node: one `'no-start'` issue (no id) — and **stop**
   there (reachability means nothing without a start).
4. Otherwise every node that cannot be reached from the start by following edges: `'unreachable'`
   with the node id. Dangling edges are ignored while walking. Cycles must not hang.

Order of issues doesn't matter.

hint: Build an adjacency map `from → [to, …]` from the valid edges.
hint: Breadth-first search: a `seen` set and a queue starting with the start node.

```ts setup
type StoryNode = { id: string; title: string; text: string; x: number; y: number }
type StoryEdge = { id: string; from: string; to: string; label: string }
type StoryDoc = { startNodeId: string | null; nodes: StoryNode[]; edges: StoryEdge[] }
type IssueCode = 'no-start' | 'dangling-edge' | 'unreachable' | 'empty-label'
type StoryIssue = { code: IssueCode; id?: string; message: string }
```

```ts starter
export function validateStory(doc: StoryDoc): StoryIssue[] {
  const issues: StoryIssue[] = []
  // TODO
  return issues
}
```

```ts solution
export function validateStory(doc: StoryDoc): StoryIssue[] {
  const issues: StoryIssue[] = []
  const ids = new Set(doc.nodes.map((n) => n.id))
  const next = new Map<string, string[]>()

  for (const e of doc.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push({ code: 'dangling-edge', id: e.id, message: `Choice "${e.label}" points to a missing scene` })
      continue
    }
    if (!e.label.trim()) issues.push({ code: 'empty-label', id: e.id, message: 'A choice has no label' })
    next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  }

  const start = doc.startNodeId
  if (start === null || !ids.has(start)) {
    issues.push({ code: 'no-start', message: 'Pick a start scene' })
    return issues
  }

  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    for (const to of next.get(cur) ?? []) {
      if (!seen.has(to)) {
        seen.add(to)
        queue.push(to)
      }
    }
  }
  for (const n of doc.nodes) {
    if (!seen.has(n.id)) issues.push({ code: 'unreachable', id: n.id, message: `"${n.title}" can never be reached` })
  }
  return issues
}
```

```ts tests
const s = (id: string): StoryNode => ({ id, title: id, text: '', x: 0, y: 0 })
const e = (id: string, from: string, to: string, label = 'go'): StoryEdge => ({ id, from, to, label })
const keysOf = (d: StoryDoc) => validateStory(d).map((i) => `${i.code}:${i.id ?? ''}`).sort()

test('a connected story has no issues', () => {
  expect(keysOf({ startNodeId: 'a', nodes: [s('a'), s('b'), s('c')], edges: [e('1', 'a', 'b'), e('2', 'a', 'c')] })).toEqual([])
})
test('an empty story has no start', () => {
  expect(keysOf({ startNodeId: null, nodes: [], edges: [] })).toEqual(['no-start:'])
})
test('a start pointing to a deleted scene counts as no start, and stops there', () => {
  expect(keysOf({ startNodeId: 'gone', nodes: [s('a'), s('b')], edges: [] })).toEqual(['no-start:'])
})
test('isolated scenes and scenes only leading out are unreachable', () => {
  const d = { startNodeId: 'a', nodes: [s('a'), s('b'), s('c'), s('d')], edges: [e('1', 'a', 'b'), e('2', 'd', 'a')] }
  expect(keysOf(d)).toEqual(['unreachable:c', 'unreachable:d'])
})
test('dangling edges are reported and ignored for reachability', () => {
  const d = { startNodeId: 'a', nodes: [s('a'), s('b')], edges: [e('1', 'a', 'b'), e('2', 'a', 'ghost', '')] }
  expect(keysOf(d)).toEqual(['dangling-edge:2'])
})
test('blank labels are reported', () => {
  const d = { startNodeId: 'a', nodes: [s('a'), s('b')], edges: [e('1', 'a', 'b', '   ')] }
  expect(keysOf(d)).toEqual(['empty-label:1'])
})
test('cycles terminate', () => {
  const d = { startNodeId: 'a', nodes: [s('a'), s('b'), s('c')], edges: [e('1', 'a', 'b'), e('2', 'b', 'a'), e('3', 'b', 'b')] }
  expect(keysOf(d)).toEqual(['unreachable:c'])
})
test('every issue has a message', () => {
  const issues = validateStory({ startNodeId: 'a', nodes: [s('a'), s('z')], edges: [e('1', 'a', 'nope')] })
  expect(issues.length).toBeGreaterThan(0)
  for (const i of issues) expect(i.message.length).toBeGreaterThan(0)
})
```
:::

## Undo and redo

Undo is where the purity pays off. A history is three things: `past` (older values), `present`,
`future` (values you undid). Every real change pushes `present` onto `past` and clears `future`.
No command objects, no inverse operations — just snapshots that share unchanged sub-objects.

:::challenge id=cap-06-c4 lang=ts xp=60
title: A generic undoable() wrapper
Write `undoable(reducer)` that returns a new reducer over `{ past, present, future }`:

- `{ type: 'undo' }`: move back one step (present goes to the **front** of `future`). Nothing to undo → same object.
- `{ type: 'redo' }`: the reverse. Nothing to redo → same object.
- any other action: run the inner reducer on `present`. If it returned the **same** value, return the
  history unchanged (no-ops are not recorded). Otherwise push the old present to `past`, clear `future`.
- keep at most `LIMIT` entries in `past` (drop the oldest).

`initHistory(present)` is given.

hint: `past[past.length - 1]` is the value to go back to; `past.slice(0, -1)` the rest.
hint: `[...h.past, h.present].slice(-LIMIT)` caps the length.

```ts setup
type Undoable<S> = { past: S[]; present: S; future: S[] }
type UndoAction = { type: 'undo' } | { type: 'redo' }
const LIMIT = 50
```

```ts starter
export function initHistory<S>(present: S): Undoable<S> {
  return { past: [], present, future: [] }
}

export function undoable<S, A extends { type: string }>(reducer: (state: S, action: A) => S) {
  return (h: Undoable<S>, action: A | UndoAction): Undoable<S> => {
    return { ...h, present: reducer(h.present, action as A) }
  }
}
```

```ts solution
export function initHistory<S>(present: S): Undoable<S> {
  return { past: [], present, future: [] }
}

export function undoable<S, A extends { type: string }>(reducer: (state: S, action: A) => S) {
  return (h: Undoable<S>, action: A | UndoAction): Undoable<S> => {
    if (action.type === 'undo') {
      if (h.past.length === 0) return h
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
    }
    if (action.type === 'redo') {
      if (h.future.length === 0) return h
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
    }
    const next = reducer(h.present, action as A)
    if (next === h.present) return h
    return { past: [...h.past, h.present].slice(-LIMIT), present: next, future: [] }
  }
}
```

```ts tests
type CounterAction = { type: 'inc' } | { type: 'set'; value: number }
const counter = (s: number, a: CounterAction) => (a.type === 'inc' ? s + 1 : a.value)
const step = undoable(counter)

test('records each change', () => {
  const h = step(step(initHistory(0), { type: 'inc' }), { type: 'inc' })
  expect(h).toEqual({ past: [0, 1], present: 2, future: [] })
})
test('undo goes back and redo forward', () => {
  let h = step(step(initHistory(0), { type: 'inc' }), { type: 'inc' })
  h = step(h, { type: 'undo' })
  expect(h).toEqual({ past: [0], present: 1, future: [2] })
  h = step(h, { type: 'undo' })
  expect(h).toEqual({ past: [], present: 0, future: [1, 2] })
  h = step(h, { type: 'redo' })
  expect(h).toEqual({ past: [0], present: 1, future: [2] })
})
test('undo with nothing to undo returns the same object', () => {
  const h = initHistory(5)
  expect(step(h, { type: 'undo' })).toBe(h)
})
test('redo with nothing to redo returns the same object', () => {
  const h = step(initHistory(0), { type: 'inc' })
  expect(step(h, { type: 'redo' })).toBe(h)
})
test('a new change clears the future', () => {
  let h = step(step(initHistory(0), { type: 'inc' }), { type: 'inc' })
  h = step(h, { type: 'undo' })
  h = step(h, { type: 'set', value: 10 })
  expect(h).toEqual({ past: [0, 1], present: 10, future: [] })
})
test('no-op changes are not recorded', () => {
  const h = step(initHistory(0), { type: 'set', value: 3 })
  expect(step(h, { type: 'set', value: 3 })).toBe(h)
})
test('past is capped at LIMIT entries', () => {
  let h = initHistory(0)
  for (let i = 0; i < 60; i++) h = step(h, { type: 'inc' })
  expect(h.past).toHaveLength(50)
  expect(h.past[0]).toBe(10)
  expect(h.present).toBe(60)
})
```
:::

:::quiz id=cap-06-q1 xp=15
Why does the `addNode` action carry a ready-made `id` instead of the reducer calling `crypto.randomUUID()`?
- [ ] `crypto.randomUUID()` is not available in browsers
- [x] A reducer must be pure: the same state + action must always give the same result (tests, undo, replaying remote changes)
- [ ] React forbids string ids inside `useReducer`
- [ ] So the server can choose the id
> Randomness, time and I/O are side effects. Keep them at the edge (the event handler) and pass the
> results in. React StrictMode even calls reducers twice in development to surface impure ones —
> with a random id inside, the two calls would disagree. `crypto.randomUUID()` *is* available in
> every modern browser (in secure contexts such as `https://` and `localhost`), and letting the
> server pick ids would mean a round trip before the scene can even appear on the canvas.
:::

:::lab id=cap-06-lab1 xp=150
title: The editor core — model, reducer, validation, history, merge

Everything in this lab is plain TypeScript: no React, no network. It is the part of the editor
that deserves the most tests. Paste your challenge solutions or use the reference versions.

**1. Model** — `web/src/modules/editor/model.ts`

```ts
export type { StoryDoc, StoryEdge, StoryNode } from '../../lib/types'
export { emptyDoc, normalizeDoc } from '../../lib/storyDoc'

export const NODE_W = 180
export const NODE_H = 72

/** Ids are created at the edge (event handlers), never inside reducers. */
export function newId(): string {
  return crypto.randomUUID()
}
```

**2. Reducer** — `web/src/modules/editor/reducer.ts`

```ts
import type { StoryDoc, StoryEdge, StoryNode } from './model'

export type NodePatch = Partial<Omit<StoryNode, 'id'>>

export type StoryAction =
  | { type: 'addNode'; node: StoryNode }
  | { type: 'updateNode'; id: string; patch: NodePatch }
  | { type: 'moveNode'; id: string; x: number; y: number }
  | { type: 'deleteNode'; id: string }
  | { type: 'connect'; edge: StoryEdge }
  | { type: 'updateEdge'; id: string; label: string }
  | { type: 'deleteEdge'; id: string }
  | { type: 'setStart'; id: string }
  | { type: 'replace'; doc: StoryDoc }

export function deleteNode(doc: StoryDoc, id: string): StoryDoc {
  if (!doc.nodes.some((n) => n.id === id)) return doc
  return {
    startNodeId: doc.startNodeId === id ? null : doc.startNodeId,
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
  }
}

function updateNode(doc: StoryDoc, id: string, patch: NodePatch): StoryDoc {
  const i = doc.nodes.findIndex((n) => n.id === id)
  if (i < 0) return doc
  const current = doc.nodes[i]
  const keys = Object.keys(patch) as (keyof NodePatch)[]
  if (!keys.some((k) => current[k] !== patch[k])) return doc // no-op → no history entry
  const nodes = doc.nodes.slice()
  nodes[i] = { ...current, ...patch }
  return { ...doc, nodes }
}

export function storyReducer(doc: StoryDoc, action: StoryAction): StoryDoc {
  switch (action.type) {
    case 'addNode': {
      if (doc.nodes.some((n) => n.id === action.node.id)) return doc
      return { ...doc, nodes: [...doc.nodes, action.node], startNodeId: doc.startNodeId ?? action.node.id }
    }
    case 'updateNode':
      return updateNode(doc, action.id, action.patch)
    case 'moveNode':
      return updateNode(doc, action.id, { x: Math.round(action.x), y: Math.round(action.y) })
    case 'deleteNode':
      return deleteNode(doc, action.id)
    case 'connect': {
      const { edge } = action
      const exists = (id: string) => doc.nodes.some((n) => n.id === id)
      if (!exists(edge.from) || !exists(edge.to)) return doc
      const duplicate = doc.edges.some(
        (e) => e.id === edge.id || (e.from === edge.from && e.to === edge.to && e.label === edge.label),
      )
      return duplicate ? doc : { ...doc, edges: [...doc.edges, edge] }
    }
    case 'updateEdge': {
      const i = doc.edges.findIndex((e) => e.id === action.id)
      if (i < 0 || doc.edges[i].label === action.label) return doc
      const edges = doc.edges.slice()
      edges[i] = { ...edges[i], label: action.label }
      return { ...doc, edges }
    }
    case 'deleteEdge':
      return doc.edges.some((e) => e.id === action.id) ? { ...doc, edges: doc.edges.filter((e) => e.id !== action.id) } : doc
    case 'setStart':
      if (doc.startNodeId === action.id || !doc.nodes.some((n) => n.id === action.id)) return doc
      return { ...doc, startNodeId: action.id }
    case 'replace':
      return action.doc
  }
}
```

**3. Validation** — `web/src/modules/editor/validate.ts`

```ts
import type { StoryDoc } from './model'

export type IssueCode = 'no-start' | 'dangling-edge' | 'unreachable' | 'empty-label'

export interface StoryIssue {
  code: IssueCode
  id?: string
  message: string
}

export function validateStory(doc: StoryDoc): StoryIssue[] {
  const issues: StoryIssue[] = []
  const ids = new Set(doc.nodes.map((n) => n.id))
  const next = new Map<string, string[]>()

  for (const e of doc.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push({ code: 'dangling-edge', id: e.id, message: `Choice "${e.label}" points to a missing scene` })
      continue
    }
    if (!e.label.trim()) issues.push({ code: 'empty-label', id: e.id, message: 'A choice has no label' })
    next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  }

  const start = doc.startNodeId
  if (start === null || !ids.has(start)) {
    issues.push({ code: 'no-start', message: 'Pick a start scene' })
    return issues
  }

  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    for (const to of next.get(cur) ?? []) {
      if (!seen.has(to)) {
        seen.add(to)
        queue.push(to)
      }
    }
  }
  for (const n of doc.nodes) {
    if (!seen.has(n.id)) issues.push({ code: 'unreachable', id: n.id, message: `"${n.title || 'Untitled scene'}" can never be reached` })
  }
  return issues
}
```

**4. History** — `web/src/modules/editor/history.ts`

Two additions over the challenge version:

- `rev` — a counter that goes up on every *local* change (including undo/redo). Autosave watches
  `rev`, not object identity, so in cap-07 changes that arrive from collaborators can update the
  document **without** making this client save them again.
- `coalesce` — typing "Hello" in the title field should be **one** undo step, not five.
  Consecutive actions with the same coalesce key replace the present instead of pushing.

```ts
import { storyReducer, type StoryAction } from './reducer'
import type { StoryDoc } from './model'

export const HISTORY_LIMIT = 100

export interface EditorHistory {
  past: StoryDoc[]
  present: StoryDoc
  future: StoryDoc[]
  /** increments on every local change; autosave compares it with the last saved rev */
  rev: number
  lastCoalesce: string | null
}

export type HistoryAction =
  | (StoryAction & { coalesce?: string })
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; doc: StoryDoc }

export function initHistory(doc: StoryDoc): EditorHistory {
  return { past: [], present: doc, future: [], rev: 0, lastCoalesce: null }
}

export function historyReducer(state: EditorHistory, action: HistoryAction): EditorHistory {
  switch (action.type) {
    case 'undo': {
      if (state.past.length === 0) return state
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
        rev: state.rev + 1,
        lastCoalesce: null,
      }
    }
    case 'redo': {
      if (state.future.length === 0) return state
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
        rev: state.rev + 1,
        lastCoalesce: null,
      }
    }
    case 'reset':
      // a fresh document from the server: forget local history, keep the rev counter
      return { ...initHistory(action.doc), rev: state.rev }
    default: {
      const next = storyReducer(state.present, action)
      if (next === state.present) return state
      const coalesce = action.coalesce ?? null
      if (coalesce !== null && coalesce === state.lastCoalesce) {
        return { ...state, present: next, future: [], rev: state.rev + 1 }
      }
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        rev: state.rev + 1,
        lastCoalesce: coalesce,
      }
    }
  }
}
```

**5. Three-way merge** — `web/src/modules/editor/merge.ts`

When a save is refused, we have three documents: **base** (what we last saved or loaded), **mine**
(local) and **theirs** (the server's latest). Per scene and per choice: if only one side changed
it, take that side; if both changed it differently, keep mine and report a conflict.

Why do we need the base at all? Comparing only *mine* with *theirs* tells you that scene 2
differs, but not **who** changed it: did I edit it, or did they? Without the answer you can't
pick a side. The base is the common ancestor that answers it, exactly like `git merge`:

| Item | base | mine | theirs | Result |
|---|---|---|---|---|
| scene 1 title | "Dock" | "Harbour" | "Dock" | "Harbour": only I changed it |
| scene 2 text | "Rain" | "Rain" | "Storm" | "Storm": only they changed it |
| scene 3 | exists | exists | *deleted* | deleted: only they changed it |
| scene 4 title | "Exit" | "Way out" | "Escape" | "Way out" + a conflict: both changed it |
| choice 3→4 | (none) | *added* | (none) | dropped: it points at scene 3, which no longer exists |

The last row is the subtle one. A merged document must still be a valid graph, so after merging
scenes, `mergeDocs` drops any choice whose endpoint didn't survive. Note the granularity: the
unit of comparison is a **whole** scene or choice. If I change scene 4's title and they change
its text, that's still a conflict (mine wins). Merging field by field is possible, but it's more
code for a rare case; the conflict count in the notice tells the user to double-check.

```ts
import type { StoryDoc } from './model'

export interface MergeResult {
  doc: StoryDoc
  /** "node:<id>", "edge:<id>" or "start" for things both sides changed differently */
  conflicts: string[]
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Structural equality that ignores key order (server JSON may order keys differently). */
export const sameValue = (a: unknown, b: unknown) => a === b || stable(a) === stable(b)

function mergeById<T extends { id: string }>(kind: string, base: T[], mine: T[], theirs: T[], conflicts: string[]): T[] {
  const b = new Map(base.map((x) => [x.id, x]))
  const m = new Map(mine.map((x) => [x.id, x]))
  const t = new Map(theirs.map((x) => [x.id, x]))
  const ids = new Set([...theirs.map((x) => x.id), ...mine.map((x) => x.id)])
  const out: T[] = []
  for (const id of ids) {
    const bx = b.get(id)
    const mx = m.get(id)
    const tx = t.get(id)
    const mineChanged = !sameValue(bx, mx)
    const theirsChanged = !sameValue(bx, tx)
    let pick: T | undefined
    if (!mineChanged) pick = tx
    else if (!theirsChanged || sameValue(mx, tx)) pick = mx
    else {
      conflicts.push(`${kind}:${id}`)
      pick = mx
    }
    if (pick) out.push(pick) // undefined = deleted on the winning side
  }
  return out
}

export function mergeDocs(base: StoryDoc, mine: StoryDoc, theirs: StoryDoc): MergeResult {
  const conflicts: string[] = []
  const nodes = mergeById('node', base.nodes, mine.nodes, theirs.nodes, conflicts)
  const ids = new Set(nodes.map((n) => n.id))
  const edges = mergeById('edge', base.edges, mine.edges, theirs.edges, conflicts).filter(
    (e) => ids.has(e.from) && ids.has(e.to),
  )

  let startNodeId: string | null
  if (mine.startNodeId === base.startNodeId) startNodeId = theirs.startNodeId
  else if (theirs.startNodeId === base.startNodeId || theirs.startNodeId === mine.startNodeId) startNodeId = mine.startNodeId
  else {
    conflicts.push('start')
    startNodeId = mine.startNodeId
  }
  if (startNodeId !== null && !ids.has(startNodeId)) startNodeId = nodes[0]?.id ?? null

  const doc: StoryDoc = { startNodeId, nodes, edges }
  // nothing of ours survived on top of theirs → hand back their exact object
  return { doc: conflicts.length === 0 && sameValue(doc, theirs) ? theirs : doc, conflicts }
}
```

**6. Tests** — `web/src/modules/editor/core.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { historyReducer, initHistory } from './history'
import { mergeDocs } from './merge'
import type { StoryDoc, StoryNode } from './model'
import { storyReducer } from './reducer'
import { validateStory } from './validate'

const node = (id: string, title = id): StoryNode => ({ id, title, text: '', x: 0, y: 0 })
const base: StoryDoc = {
  startNodeId: 'a',
  nodes: [node('a'), node('b')],
  edges: [{ id: 'ab', from: 'a', to: 'b', label: 'Go' }],
}

describe('storyReducer', () => {
  it('deleteNode cascades to choices and the start', () => {
    const d = storyReducer(base, { type: 'deleteNode', id: 'a' })
    expect(d.edges).toEqual([])
    expect(d.startNodeId).toBeNull()
  })
  it('an unchanged updateNode is a no-op', () => {
    expect(storyReducer(base, { type: 'updateNode', id: 'a', patch: { title: 'a' } })).toBe(base)
  })
})

describe('validateStory', () => {
  it('flags an orphan scene', () => {
    const d = storyReducer(base, { type: 'addNode', node: node('c') })
    expect(validateStory(d).map((i) => `${i.code}:${i.id}`)).toEqual(['unreachable:c'])
  })
})

describe('historyReducer', () => {
  it('coalesces typing into one undo step and counts revisions', () => {
    let h = initHistory(base)
    for (const title of ['H', 'He', 'Hey']) {
      h = historyReducer(h, { type: 'updateNode', id: 'a', patch: { title }, coalesce: 'title:a' })
    }
    expect(h.past).toHaveLength(1)
    expect(h.rev).toBe(3)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present).toBe(base)
    expect(h.rev).toBe(4)
  })
  it('reset clears history but keeps rev', () => {
    let h = historyReducer(initHistory(base), { type: 'deleteNode', id: 'b' })
    h = historyReducer(h, { type: 'reset', doc: base })
    expect(h.past).toEqual([])
    expect(h.rev).toBe(1)
  })
})

describe('mergeDocs', () => {
  it('combines edits to different scenes', () => {
    const mine = storyReducer(base, { type: 'updateNode', id: 'a', patch: { title: 'Mine' } })
    const theirs = storyReducer(base, { type: 'updateNode', id: 'b', patch: { title: 'Theirs' } })
    const r = mergeDocs(base, mine, theirs)
    expect(r.conflicts).toEqual([])
    expect(r.doc.nodes.map((n) => n.title)).toEqual(['Mine', 'Theirs'])
  })
  it('reports a conflict and keeps mine when both edit the same scene', () => {
    const mine = storyReducer(base, { type: 'updateNode', id: 'a', patch: { title: 'Mine' } })
    const theirs = storyReducer(base, { type: 'updateNode', id: 'a', patch: { title: 'Theirs' } })
    const r = mergeDocs(base, mine, theirs)
    expect(r.conflicts).toEqual(['node:a'])
    expect(r.doc.nodes[0].title).toBe('Mine')
  })
  it('their deletion cascades to my new choice into that scene', () => {
    const mine = storyReducer(base, { type: 'connect', edge: { id: 'bb', from: 'b', to: 'b', label: 'Loop' } })
    const theirs = storyReducer(base, { type: 'deleteNode', id: 'b' })
    const r = mergeDocs(base, mine, theirs)
    expect(r.doc.nodes.map((n) => n.id)).toEqual(['a'])
    expect(r.doc.edges).toEqual([])
  })
  it('returns their object when I changed nothing', () => {
    const theirs = storyReducer(base, { type: 'updateNode', id: 'b', patch: { title: 'New' } })
    expect(mergeDocs(base, base, theirs).doc).toBe(theirs)
  })
})
```

```bash
cd web
npm test
```

- [ ] `model.ts`, `reducer.ts`, `validate.ts`, `history.ts` and `merge.ts` exist under `src/modules/editor/`
- [ ] `core.test.ts` passes (9 tests) together with the cap-05 tests
- [ ] I can explain why the reducer returns the **same** object for no-ops (history and autosave rely on it)
- [ ] I can explain what `rev` is for and why it is not the server `version`
:::

## Autosave without losing work

Manual "Save" buttons lose work; saving on every keystroke hammers the API and multiplies
conflicts. **Debounced autosave** sits in between: wait until the user pauses (~800 ms), then save
the latest document. *Debounce* means every new edit restarts the timer, so the save fires only
after a quiet period:

```text
keystrokes   H   e   y                       (pause)
timer        ├──X├──X├────────── 800 ms ──────► PUT /doc  (one request, with "Hey")
             each new edit cancels the previous timer (X) and starts a fresh one
```

Details that separate a toy from a product:

- **Single flight.** Never run two saves of the same document at once — the second would carry
  the same `expectedVersion` and be refused because of your own first save. Edits made during a
  save get their own save afterwards.
- **Stop on conflict.** After a 409, autosaving again would just produce more 409s. Block until the
  user resolves it. Other failures (offline, a `400` because cap-04's `StoryDocRules` refuse a story
  whose start scene was deleted) keep the edits and retry on the next edit or on **Retry**.
- **Optimistic cache.** The editor shows changes instantly (that *is* the optimistic update). The
  save mutation also writes the new document into the TanStack Query cache immediately and rolls
  the cache back if the server refuses, so other screens (the list's version and "updated" time)
  stay honest.
- **Warn before leaving** with unsaved changes (`beforeunload`).

:::warn title="Last write wins is data loss"
Without `expectedVersion` the second save simply replaces the first. Two authors, one editing the
ending and one fixing a typo in the intro, and one of them loses their work without any error.
Optimistic concurrency (cap-04) turns that silent loss into an explicit **409** the UI can handle.
:::

### The three ways out of a conflict

| Option | What happens | When it's right |
|---|---|---|
| **Reload theirs** | discard local changes, load the server document and version | my changes were trivial |
| **Overwrite with mine** | resend my document with `expectedVersion = currentVersion` | I know theirs is wrong — destructive, so make it look dangerous |
| **Merge** | three-way merge base / mine / theirs, save the result | almost always; the safe default focus |

:::challenge id=cap-06-c5 lang=tsx xp=60 preview=ConflictPreview
title: An accessible conflict dialog
Build `ConflictDialog({ currentVersion, onReload, onOverwrite, onMerge })`:

- a container with `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at an `h2`
  that reads **Someone else saved this story**
- a paragraph containing `The server is at version <currentVersion>.`
- three buttons in this order: **Reload theirs**, **Overwrite with mine**, **Merge**, each calling its handler
- **Merge** has keyboard focus when the dialog appears (the safe default)
- focus is trapped: `Tab` on **Merge** moves to **Reload theirs**; `Shift+Tab` on **Reload theirs** moves to **Merge**

hint: `useId()` for the heading id; `useRef` + `useEffect(() => ref.current?.focus(), [])` for the initial focus.
hint: Handle `onKeyDown` on the dialog: when `e.key === 'Tab'` and focus is on the last/first button, call `preventDefault()` and move it.

```tsx setup
type ConflictDialogProps = {
  currentVersion: number
  onReload: () => void
  onOverwrite: () => void
  onMerge: () => void
}

function ConflictPreview() {
  return (
    <ConflictDialog
      currentVersion={8}
      onReload={() => console.log('reload')}
      onOverwrite={() => console.log('overwrite')}
      onMerge={() => console.log('merge')}
    />
  )
}
```

```tsx starter
import { useEffect, useId, useRef } from 'react'

export function ConflictDialog({ currentVersion, onReload, onOverwrite, onMerge }: ConflictDialogProps) {
  return (
    <div>
      <p>Conflict!</p>
    </div>
  )
}
```

```tsx solution
import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'

export function ConflictDialog({ currentVersion, onReload, onOverwrite, onMerge }: ConflictDialogProps) {
  const titleId = useId()
  const firstRef = useRef<HTMLButtonElement>(null)
  const mergeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mergeRef.current?.focus()
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return
    if (!e.shiftKey && document.activeElement === mergeRef.current) {
      e.preventDefault()
      firstRef.current?.focus()
    } else if (e.shiftKey && document.activeElement === firstRef.current) {
      e.preventDefault()
      mergeRef.current?.focus()
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <h2 id={titleId}>Someone else saved this story</h2>
      <p>The server is at version {currentVersion}.</p>
      <button ref={firstRef} onClick={onReload}>Reload theirs</button>
      <button onClick={onOverwrite}>Overwrite with mine</button>
      <button ref={mergeRef} onClick={onMerge}>Merge</button>
    </div>
  )
}
```

```tsx tests
const noop = () => {}

test('is a modal dialog named by its heading', () => {
  render(<ConflictDialog currentVersion={7} onReload={noop} onOverwrite={noop} onMerge={noop} />)
  const dialog = screen.getByRole('dialog', { name: 'Someone else saved this story' })
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(dialog).toHaveTextContent('The server is at version 7.')
})
test('each button calls its handler', async () => {
  const onReload = fn()
  const onOverwrite = fn()
  const onMerge = fn()
  render(<ConflictDialog currentVersion={3} onReload={onReload} onOverwrite={onOverwrite} onMerge={onMerge} />)
  await user.click(screen.getByRole('button', { name: 'Reload theirs' }))
  await user.click(screen.getByRole('button', { name: 'Overwrite with mine' }))
  await user.click(screen.getByRole('button', { name: 'Merge' }))
  expect(onReload).toHaveBeenCalledTimes(1)
  expect(onOverwrite).toHaveBeenCalledTimes(1)
  expect(onMerge).toHaveBeenCalledTimes(1)
})
test('buttons come in the documented order', () => {
  render(<ConflictDialog currentVersion={3} onReload={noop} onOverwrite={noop} onMerge={noop} />)
  expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Reload theirs', 'Overwrite with mine', 'Merge'])
})
test('Merge has focus initially', async () => {
  render(<ConflictDialog currentVersion={3} onReload={noop} onOverwrite={noop} onMerge={noop} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Merge' })).toHaveFocus())
})
test('Tab on Merge wraps to Reload theirs instead of leaving the dialog', async () => {
  render(
    <div>
      <ConflictDialog currentVersion={3} onReload={noop} onOverwrite={noop} onMerge={noop} />
      <button>Outside</button>
    </div>,
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Merge' })).toHaveFocus())
  await user.keyboard('{Tab}')
  expect(screen.getByRole('button', { name: 'Reload theirs' })).toHaveFocus()
})
test('Shift+Tab on Reload theirs wraps to Merge', async () => {
  render(
    <div>
      <button>Outside</button>
      <ConflictDialog currentVersion={3} onReload={noop} onOverwrite={noop} onMerge={noop} />
    </div>,
  )
  const merge = screen.getByRole('button', { name: 'Merge' })
  await waitFor(() => expect(merge).toHaveFocus())
  const first = screen.getByRole('button', { name: 'Reload theirs' })
  act(() => first.focus())
  await user.tab({ shift: true })
  expect(merge).toHaveFocus()
})
```
:::

:::lab id=cap-06-lab2 xp=200
title: Autosave, the canvas and the editor page

**1. The save mutation** — `web/src/modules/editor/queries.ts`

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { ProjectDetail, ProjectSummary, SaveDocRequest } from '../../lib/types'
import { projectKeys } from '../projects'

export function useSaveDoc(projectId: string) {
  const qc = useQueryClient()
  const detailKey = projectKeys.detail(projectId)
  return useMutation({
    mutationFn: (req: SaveDocRequest) => api.saveDoc(projectId, req),
    // optimistic: the cache shows the document we are saving right away
    onMutate: async (req) => {
      await qc.cancelQueries({ queryKey: detailKey })
      const previous = qc.getQueryData<ProjectDetail>(detailKey)
      if (previous) qc.setQueryData<ProjectDetail>(detailKey, { ...previous, doc: req.doc })
      return { previous }
    },
    onError: (_err, _req, ctx) => {
      if (ctx?.previous) qc.setQueryData(detailKey, ctx.previous)
    },
    onSuccess: (res, req) => {
      const { updatedAt } = res
      qc.setQueryData<ProjectDetail>(detailKey, (old) => old && { ...old, doc: req.doc, version: res.version, updatedAt })
      qc.setQueryData<ProjectSummary[]>(projectKeys.list(), (list) =>
        list?.map((p) => (p.id === projectId ? { ...p, version: res.version, updatedAt } : p)),
      )
    },
  })
}
```

**2. The autosave hook** — `web/src/modules/editor/useAutosave.ts`

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import type { StoryDoc } from './model'

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error'

export interface AutosaveOptions {
  doc: StoryDoc
  /** local revision counter from the history reducer */
  rev: number
  save: (doc: StoryDoc) => Promise<void>
  delay?: number
  enabled?: boolean
}

export function useAutosave({ doc, rev, save, delay = 800, enabled = true }: AutosaveOptions) {
  const [phase, setPhase] = useState<'idle' | 'saving' | 'conflict' | 'error'>('idle')
  const [error, setError] = useState<unknown>(null)
  const [savedRev, setSavedRev] = useState(rev)

  const latest = useRef({ doc, rev, save })
  const savedRevRef = useRef(rev)
  const savedDocRef = useRef(doc)
  const inFlight = useRef(false)
  const blocked = useRef(false)

  // keep the newest values for callbacks that outlive this render (timers, promises)
  useEffect(() => {
    latest.current = { doc, rev, save }
  })

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) return // single flight: the running loop picks up newer edits
    inFlight.current = true
    try {
      // loop: edits made while a save was running get their own save right after it
      while (!blocked.current && latest.current.rev !== savedRevRef.current) {
        const snapshot = latest.current
        setPhase('saving')
        try {
          await snapshot.save(snapshot.doc)
          savedDocRef.current = snapshot.doc
          savedRevRef.current = snapshot.rev
          setSavedRev(snapshot.rev)
          setError(null)
          setPhase('idle')
        } catch (e) {
          const conflict = e instanceof ApiError && (e.status === 409 || e.status === 412)
          // a conflict blocks until resume()/markSaved(); other errors retry on the next edit or Retry
          if (conflict) blocked.current = true
          setError(e)
          setPhase(conflict ? 'conflict' : 'error')
          break
        }
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  // debounce: every new revision restarts the timer
  useEffect(() => {
    if (!enabled || rev === savedRevRef.current) return
    const t = window.setTimeout(() => void flush(), delay)
    return () => window.clearTimeout(t)
  }, [rev, enabled, delay, flush])

  const dirty = rev !== savedRev

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  /** Unblock after a conflict/error (the caller may have changed the expected version) and save now. */
  const resume = useCallback(() => {
    blocked.current = false
    setError(null)
    setPhase('idle')
    void flush()
  }, [flush])

  /** Declare `serverDoc` as what the server has, as of local revision `atRev`. */
  const markSaved = useCallback((serverDoc: StoryDoc, atRev: number) => {
    savedDocRef.current = serverDoc
    savedRevRef.current = atRev
    setSavedRev(atRev)
    blocked.current = false
    setError(null)
    setPhase('idle')
  }, [])

  const getSavedDoc = useCallback(() => savedDocRef.current, [])

  const status: SaveStatus =
    phase === 'conflict' ? 'conflict' : phase === 'error' ? 'error' : phase === 'saving' ? 'saving' : dirty ? 'unsaved' : 'saved'

  return { status, error, dirty, flush, resume, markSaved, getSavedDoc }
}
```

`web/src/modules/editor/useAutosave.test.tsx` — fake timers make debounce tests instant and exact:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ApiError } from '../../lib/api'
import type { StoryDoc } from './model'
import { useAutosave } from './useAutosave'

const docTitled = (title: string): StoryDoc => ({
  startNodeId: 'a',
  nodes: [{ id: 'a', title, text: '', x: 0, y: 0 }],
  edges: [],
})

type Props = { doc: StoryDoc; rev: number }

describe('useAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('saves once, after the edits stop', async () => {
    const save = vi.fn(async (_doc: StoryDoc) => {})
    const d2 = docTitled('two')
    const { result, rerender } = renderHook((p: Props) => useAutosave({ ...p, save, delay: 500 }), {
      initialProps: { doc: docTitled('zero'), rev: 0 },
    })
    expect(result.current.status).toBe('saved')

    rerender({ doc: docTitled('one'), rev: 1 })
    expect(result.current.status).toBe('unsaved')
    await act(() => vi.advanceTimersByTimeAsync(300))
    rerender({ doc: d2, rev: 2 })
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(save).not.toHaveBeenCalled()

    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(d2)
    expect(result.current.status).toBe('saved')
    expect(result.current.getSavedDoc()).toBe(d2)
  })

  it('stops after a 409 until resumed', async () => {
    const save = vi.fn(async (_doc: StoryDoc): Promise<void> => {
      throw new ApiError(409, { title: 'Version conflict', currentVersion: 9 })
    })
    const { result, rerender } = renderHook((p: Props) => useAutosave({ ...p, save, delay: 500 }), {
      initialProps: { doc: docTitled('a'), rev: 0 },
    })

    rerender({ doc: docTitled('b'), rev: 1 })
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(result.current.status).toBe('conflict')

    rerender({ doc: docTitled('c'), rev: 2 })
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(save).toHaveBeenCalledTimes(1)

    save.mockImplementation(async () => {})
    await act(async () => {
      result.current.resume()
    })
    expect(save).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('saved')
  })
})
```

**3. Small presentational pieces.**

`web/src/modules/editor/SaveIndicator.tsx`

```tsx
import type { SaveStatus } from './useAutosave'

const LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Conflict — choose how to resolve',
  error: 'Save failed',
}

export function SaveIndicator({ status, version }: { status: SaveStatus; version: number }) {
  return (
    <span role="status" className="bs-status" data-state={status}>
      {LABEL[status]}
      {status === 'saved' && ` · v${version}`}
    </span>
  )
}
```

`web/src/modules/editor/IssuesPanel.tsx`

```tsx
import { Button } from '../ui'
import type { StoryIssue } from './validate'

export function IssuesPanel({ issues, onShow }: { issues: StoryIssue[]; onShow: (nodeId: string) => void }) {
  if (issues.length === 0) return <p className="bs-muted">No problems found — the story is playable.</p>
  return (
    <section className="bs-issues bs-card" aria-labelledby="issues-heading">
      <h2 id="issues-heading">Problems ({issues.length})</h2>
      <ul>
        {issues.map((issue, i) => (
          <li key={`${issue.code}:${issue.id ?? i}`}>
            {issue.message}{' '}
            {issue.code === 'unreachable' && issue.id && (
              <Button variant="ghost" onClick={() => onShow(issue.id!)}>
                Show
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

`web/src/modules/editor/ConflictDialog.tsx` — the challenge component, built on the kit's `Dialog`
(non-dismissible: Escape must not silently pick an option):

```tsx
import { Button, Dialog } from '../ui'

export interface ConflictDialogProps {
  currentVersion: number | undefined
  busy: boolean
  onReload: () => void
  onOverwrite: () => void
  onMerge: () => void
}

export function ConflictDialog({ currentVersion, busy, onReload, onOverwrite, onMerge }: ConflictDialogProps) {
  return (
    <Dialog open title="Someone else saved this story" onClose={() => {}} dismissible={false}>
      <p>Your changes were based on an older version. The server is at version {currentVersion ?? 'unknown'}.</p>
      <ul className="bs-muted">
        <li><strong>Merge</strong> keeps both sets of changes (yours win where you both edited the same thing).</li>
        <li><strong>Reload theirs</strong> discards your unsaved changes.</li>
        <li><strong>Overwrite with mine</strong> replaces their changes with yours.</li>
      </ul>
      <div className="bs-row">
        <Button onClick={onReload} disabled={busy}>Reload theirs</Button>
        <Button variant="danger" onClick={onOverwrite} disabled={busy}>Overwrite with mine</Button>
        <Button variant="primary" onClick={onMerge} disabled={busy} data-autofocus>Merge</Button>
      </div>
    </Dialog>
  )
}
```

**4. The canvas** — `web/src/modules/editor/GraphCanvas.tsx`

Scenes are absolutely positioned **buttons**: focusable with `Tab`, selectable with a click,
`Enter` or `Space`, and movable with the arrow keys (`Shift` for bigger steps). A `<div>` with
an `onClick` would work for mouse users only. Choices are SVG curves underneath. While dragging,
the position lives in local state; only the drop dispatches `moveNode`, so one drag is one undo
step and one autosave, not one per pixel.

:::warn title="Pointer events don't fire for the keyboard"
`onPointerDown` selects a node for mouse, pen and touch users. Pressing `Enter` or `Space` on a
focused button fires only `click`. That's why the node also has `onClick={() => onSelect(n.id)}`.
Without it, keyboard users could move scenes but never open them in the inspector.
:::

```tsx
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { NODE_H, NODE_W, type StoryDoc, type StoryNode } from './model'

interface Drag {
  id: string
  offsetX: number
  offsetY: number
  x: number
  y: number
}

export interface GraphCanvasProps {
  doc: StoryDoc
  selectedId: string | null
  readOnly: boolean
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }

export function GraphCanvas({ doc, selectedId, readOnly, onSelect, onMove }: GraphCanvasProps) {
  const markerId = `arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [drag, setDrag] = useState<Drag | null>(null)
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const posOf = (n: StoryNode) => (drag?.id === n.id ? { x: drag.x, y: drag.y } : { x: n.x, y: n.y })
  const width = Math.max(800, ...doc.nodes.map((n) => posOf(n).x + NODE_W + 80))
  const height = Math.max(480, ...doc.nodes.map((n) => posOf(n).y + NODE_H + 80))

  function onPointerDown(e: PointerEvent<HTMLButtonElement>, n: StoryNode) {
    onSelect(n.id)
    if (readOnly || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id: n.id, offsetX: e.clientX - n.x, offsetY: e.clientY - n.y, x: n.x, y: n.y })
  }

  function onPointerMove(e: PointerEvent<HTMLButtonElement>) {
    if (!drag) return
    setDrag({ ...drag, x: Math.max(0, e.clientX - drag.offsetX), y: Math.max(0, e.clientY - drag.offsetY) })
  }

  function onPointerUp() {
    if (!drag) return
    const n = byId.get(drag.id)
    if (n && (n.x !== drag.x || n.y !== drag.y)) onMove(drag.id, drag.x, drag.y)
    setDrag(null)
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, n: StoryNode) {
    const dir = ARROWS[e.key]
    if (readOnly || !dir) return
    e.preventDefault()
    const step = e.shiftKey ? 50 : 10
    onMove(n.id, Math.max(0, n.x + dir[0] * step), Math.max(0, n.y + dir[1] * step))
  }

  function edgePath(from: StoryNode, to: StoryNode) {
    const a = posOf(from)
    const b = posOf(to)
    if (from.id === to.id) {
      const x = a.x + NODE_W / 2
      return { d: `M${x - 30},${a.y} C${x - 70},${a.y - 70} ${x + 70},${a.y - 70} ${x + 30},${a.y}`, lx: x, ly: a.y - 56 }
    }
    const x1 = a.x + NODE_W
    const y1 = a.y + NODE_H / 2
    const x2 = b.x
    const y2 = b.y + NODE_H / 2
    const bend = Math.max(40, Math.abs(x2 - x1) / 2)
    return { d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 8 }
  }

  return (
    <div className="bs-canvas" role="group" aria-label="Story graph">
      <div className="bs-canvas__inner" style={{ width, height }}>
        <svg className="bs-canvas__edges" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          </defs>
          {doc.edges.map((e) => {
            const from = byId.get(e.from)
            const to = byId.get(e.to)
            if (!from || !to) return null
            const p = edgePath(from, to)
            return (
              <g key={e.id}>
                <path d={p.d} markerEnd={`url(#${markerId})`} />
                <text x={p.lx} y={p.ly} textAnchor="middle">{e.label}</text>
              </g>
            )
          })}
        </svg>

        {doc.nodes.map((n) => {
          const p = posOf(n)
          const isStart = n.id === doc.startNodeId
          return (
            <button
              key={n.id}
              type="button"
              className="bs-node"
              aria-pressed={n.id === selectedId}
              data-start={isStart || undefined}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
              onClick={() => onSelect(n.id)} // Enter/Space select it too (no pointer events then)
              onPointerDown={(e) => onPointerDown(e, n)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => onKeyDown(e, n)}
            >
              <span className="bs-node__title">{n.title || 'Untitled scene'}</span>
              {isStart && <span className="bs-node__badge">Start</span>}
            </button>
          )
        })}
        {doc.nodes.length === 0 && <p className="bs-canvas__empty bs-muted">No scenes yet. Use “Add scene” to begin.</p>}
      </div>
    </div>
  )
}
```

**5. The inspector** — `web/src/modules/editor/NodeInspector.tsx`

```tsx
import { useId, useState, type FormEvent } from 'react'
import { Button, SelectField, TextAreaField, TextField } from '../ui'
import type { HistoryAction } from './history'
import { newId, type StoryDoc, type StoryNode } from './model'
import type { NodePatch } from './reducer'

export interface NodeInspectorProps {
  doc: StoryDoc
  node: StoryNode
  readOnly: boolean
  dispatch: (action: HistoryAction) => void
}

export function NodeInspector({ doc, node, readOnly, dispatch }: NodeInspectorProps) {
  const headingId = useId()
  const [target, setTarget] = useState('')
  const [label, setLabel] = useState('')
  const outgoing = doc.edges.filter((e) => e.from === node.id)
  const titleOf = (id: string) => doc.nodes.find((n) => n.id === id)?.title || 'Untitled scene'
  const update = (patch: NodePatch, field: string) =>
    dispatch({ type: 'updateNode', id: node.id, patch, coalesce: `${field}:${node.id}` })

  function addChoice(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!target) return
    dispatch({ type: 'connect', edge: { id: newId(), from: node.id, to: target, label: label.trim() || 'Continue' } })
    setLabel('')
  }

  return (
    <aside className="bs-inspector bs-stack" aria-labelledby={headingId}>
      <h2 id={headingId}>Scene</h2>
      {/* maxLength mirrors cap-04's server rule (titles ≤ 120), so autosave can't produce a 400 here */}
      <TextField label="Title" maxLength={120} value={node.title} disabled={readOnly} onChange={(e) => update({ title: e.target.value }, 'title')} />
      <TextAreaField label="Text" rows={5} value={node.text} disabled={readOnly} onChange={(e) => update({ text: e.target.value }, 'text')} />
      <TextField
        label="Media URL"
        type="url"
        placeholder="https://…"
        value={node.mediaUrl ?? ''}
        disabled={readOnly}
        onChange={(e) => update({ mediaUrl: e.target.value || null }, 'media')}
      />

      {!readOnly && (
        <div className="bs-row">
          <Button onClick={() => dispatch({ type: 'setStart', id: node.id })} disabled={doc.startNodeId === node.id}>
            Set as start
          </Button>
          <Button variant="danger" onClick={() => dispatch({ type: 'deleteNode', id: node.id })}>
            Delete scene
          </Button>
        </div>
      )}

      <h3>Choices</h3>
      {outgoing.length === 0 ? (
        <p className="bs-muted">No choices — this scene is an ending.</p>
      ) : (
        <ul className="bs-choice-list">
          {outgoing.map((e) => (
            <li key={e.id} className="bs-row bs-row--end">
              <TextField
                label={`Choice to “${titleOf(e.to)}”`}
                value={e.label}
                disabled={readOnly}
                onChange={(ev) => dispatch({ type: 'updateEdge', id: e.id, label: ev.target.value, coalesce: `edge:${e.id}` })}
              />
              {!readOnly && (
                <Button variant="ghost" aria-label={`Remove choice ${e.label || 'without label'}`} onClick={() => dispatch({ type: 'deleteEdge', id: e.id })}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <form className="bs-stack" onSubmit={addChoice} aria-label="Add a choice">
          <SelectField label="Target scene" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a scene…</option>
            {doc.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {(n.title || 'Untitled scene') + (n.id === node.id ? ' (this scene)' : '')}
              </option>
            ))}
          </SelectField>
          <TextField label="Choice label" placeholder="Open the door" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" variant="primary" disabled={!target}>
            Add choice
          </Button>
        </form>
      )}
    </aside>
  )
}
```

**6. Styles** — `web/src/modules/editor/editor.css`

```css
.bs-editor { display: flex; flex-direction: column; gap: var(--bs-space-4); }
.bs-editor__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--bs-space-2); }
.bs-editor__bar h1 { font-size: 1.4rem; margin-right: auto; }
.bs-editor__body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--bs-space-4); align-items: start; }
@media (max-width: 900px) { .bs-editor__body { grid-template-columns: 1fr; } }

.bs-canvas { overflow: auto; height: 65vh; border: 1px solid var(--bs-border); border-radius: var(--bs-radius-lg);
  background-color: var(--bs-surface); background-image: radial-gradient(var(--bs-border) 1px, transparent 1px); background-size: 20px 20px; }
.bs-canvas__inner { position: relative; }
.bs-canvas__edges { position: absolute; inset: 0; pointer-events: none; }
.bs-canvas__edges path { fill: none; stroke: var(--bs-muted); stroke-width: 2; }
.bs-canvas__edges marker path { fill: var(--bs-muted); stroke: none; }
.bs-canvas__edges text { fill: var(--bs-text); font-size: 12px; }
.bs-canvas__empty { position: absolute; left: 24px; top: 24px; margin: 0; }

.bs-node { position: absolute; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px;
  padding: 8px 12px; font: inherit; text-align: left; color: var(--bs-text); background: var(--bs-surface-2);
  border: 2px solid var(--bs-border); border-radius: var(--bs-radius); cursor: grab; touch-action: none; user-select: none; }
.bs-node[aria-pressed='true'] { border-color: var(--bs-primary); }
.bs-node[data-start] { box-shadow: inset 5px 0 0 var(--bs-success); }
.bs-node__title { font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bs-node__badge { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; color: var(--bs-success); }

.bs-inspector { background: var(--bs-surface); border: 1px solid var(--bs-border); border-radius: var(--bs-radius-lg); padding: var(--bs-space-4); }
.bs-choice-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--bs-space-2); }
.bs-issues ul { margin: 0; padding-left: 1.2rem; }
.bs-status { font-size: 0.875rem; color: var(--bs-muted); min-width: 9rem; }
.bs-status[data-state='conflict'], .bs-status[data-state='error'] { color: var(--bs-danger); }
.bs-notice { display: flex; align-items: center; gap: var(--bs-space-2); margin: 0; }
```

**7. The page** — replace `web/src/modules/editor/EditorPage.tsx`

`key={project.data.id}` on `<Editor>` matters: navigating from one story to another **remounts**
the editor, so no state (history, versions, autosave timers) leaks between stories.

```tsx
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import type { ProjectDetail } from '../../lib/types'
import { fetchProject, projectKeys, useProject } from '../projects'
import { Button, Spinner } from '../ui'
import { ConflictDialog } from './ConflictDialog'
import { GraphCanvas } from './GraphCanvas'
import { historyReducer, initHistory } from './history'
import { IssuesPanel } from './IssuesPanel'
import { mergeDocs } from './merge'
import { newId, type StoryDoc } from './model'
import { NodeInspector } from './NodeInspector'
import { useSaveDoc } from './queries'
import { SaveIndicator } from './SaveIndicator'
import { useAutosave } from './useAutosave'
import { validateStory } from './validate'
import './editor.css'

/** The first validation message (e.g. "startNodeId must reference an existing node."), else the error text. */
function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return Object.values(err.problem.errors ?? {})[0]?.[0] ?? err.message
  return 'the server could not be reached.'
}

export function EditorPage() {
  const { projectId = '' } = useParams()
  const project = useProject(projectId)
  if (project.isPending) return <Spinner label="Loading story" />
  if (project.isError) return <p role="alert" className="bs-error">Could not load this story: {project.error.message}</p>
  return <Editor key={project.data.id} project={project.data} />
}

function Editor({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient()
  const readOnly = project.role === 'viewer'
  const [hist, dispatch] = useReducer(historyReducer, project.doc, initHistory)
  const [selectedId, setSelectedId] = useState<string | null>(project.doc.startNodeId)
  const versionRef = useRef(project.version) // what we send as expectedVersion
  const [version, setVersion] = useState(project.version) // what we display
  const [notice, setNotice] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const { mutateAsync: saveDoc } = useSaveDoc(project.id)

  const setServerVersion = (v: number) => {
    versionRef.current = v
    setVersion(v)
  }

  const save = useCallback(
    async (doc: StoryDoc) => {
      const res = await saveDoc({ expectedVersion: versionRef.current, doc })
      versionRef.current = res.version
      setVersion(res.version)
    },
    [saveDoc],
  )

  const autosave = useAutosave({ doc: hist.present, rev: hist.rev, save, enabled: !readOnly })
  const issues = useMemo(() => validateStory(hist.present), [hist.present])
  const selected = hist.present.nodes.find((n) => n.id === selectedId)
  const conflictVersion = autosave.error instanceof ApiError ? autosave.error.currentVersion : undefined

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z — but leave text fields their native undo
  useEffect(() => {
    if (readOnly) return
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly])

  const fetchLatest = () =>
    qc.fetchQuery({ queryKey: projectKeys.detail(project.id), queryFn: () => fetchProject(project.id), staleTime: 0 })

  async function resolveConflict(choice: 'reload' | 'overwrite' | 'merge') {
    setResolving(true)
    try {
      if (choice === 'overwrite') {
        setServerVersion(conflictVersion ?? (await fetchLatest()).version)
        autosave.resume() // re-sends my document against the version I have now seen
        return
      }
      const latest = await fetchLatest()
      setServerVersion(latest.version)
      if (choice === 'reload') {
        dispatch({ type: 'reset', doc: latest.doc })
        autosave.markSaved(latest.doc, hist.rev)
        setNotice('Loaded the latest version from the server.')
      } else {
        const { doc, conflicts } = mergeDocs(autosave.getSavedDoc(), hist.present, latest.doc)
        autosave.markSaved(latest.doc, hist.rev) // base is now theirs …
        dispatch({ type: 'replace', doc }) // … and the merge is a new local revision → autosave
        setNotice(
          conflicts.length
            ? `Merged. ${conflicts.length} item(s) were changed on both sides — your version was kept.`
            : 'Merged both sets of changes.',
        )
      }
    } catch (e) {
      setNotice(`Could not resolve the conflict: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setResolving(false)
    }
  }

  function addScene() {
    const n = hist.present.nodes.length
    // same key order and null mediaUrl as the server's JSON, so structural comparisons stay cheap
    const node = { id: newId(), title: `Scene ${n + 1}`, text: '', mediaUrl: null, x: 40 + (n % 4) * 220, y: 40 + Math.floor(n / 4) * 130 }
    dispatch({ type: 'addNode', node })
    setSelectedId(node.id)
  }

  return (
    <div className="bs-editor">
      <div className="bs-editor__bar">
        <h1>{project.title}</h1>
        {readOnly && <span className="bs-badge">Read-only</span>}
        <SaveIndicator status={autosave.status} version={version} />
        <Button onClick={addScene} disabled={readOnly}>Add scene</Button>
        <Button onClick={() => dispatch({ type: 'undo' })} disabled={readOnly || hist.past.length === 0}>Undo</Button>
        <Button onClick={() => dispatch({ type: 'redo' })} disabled={readOnly || hist.future.length === 0}>Redo</Button>
      </div>

      {notice && (
        <p className="bs-notice" role="status">
          {notice}
          <Button variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>
        </p>
      )}
      {autosave.status === 'error' && (
        <p role="alert" className="bs-notice bs-error">
          Saving failed: {saveErrorMessage(autosave.error)} Your changes are still here.
          <Button onClick={autosave.resume}>Retry</Button>
        </p>
      )}

      <div className="bs-editor__body">
        <GraphCanvas
          doc={hist.present}
          selectedId={selectedId}
          readOnly={readOnly}
          onSelect={setSelectedId}
          onMove={(id, x, y) => dispatch({ type: 'moveNode', id, x, y })}
        />
        {selected ? (
          <NodeInspector key={selected.id} doc={hist.present} node={selected} readOnly={readOnly} dispatch={dispatch} />
        ) : (
          <aside className="bs-inspector">
            <p className="bs-muted">Select a scene to edit it.</p>
          </aside>
        )}
      </div>

      <IssuesPanel issues={issues} onShow={setSelectedId} />

      {autosave.status === 'conflict' && (
        <ConflictDialog
          currentVersion={conflictVersion}
          busy={resolving}
          onReload={() => void resolveConflict('reload')}
          onOverwrite={() => void resolveConflict('overwrite')}
          onMerge={() => void resolveConflict('merge')}
        />
      )}
    </div>
  )
}
```

**8. Provoke a conflict on purpose.** Run `npm run dev`. A new story starts with only the opening
scene, so in window A click **Add scene** first and wait for **Saved · v2**. Open the same story in
a second window B (sign in again as the same user: the token lives in `sessionStorage`, which a new
window doesn't share). In A rename the opening scene and wait for **Saved · v3**. In B (still on v2)
edit Scene 2's text: B's autosave gets a 409 and the dialog opens with focus on **Merge**. Choose
Merge: the two edits touch different scenes, so B shows both and saves v4. Reload A to see them.

```bash
npm test     # cap-05 + core + autosave tests
npx tsc -b
```

:::job title="Conflicts in the wild"
Google Docs, Figma and Notion hide most conflicts with real-time merging (cap-07), but every one
of them still has a server-side version check underneath. In code review, a save endpoint
without a version check, or a client that blindly retries a 409, is a blocking comment.
:::

- [ ] Adding, moving (mouse and arrow keys), connecting and deleting scenes works; deleting a scene removes its choices
- [ ] Typing a title produces **one** undo step; Ctrl/Cmd+Z and the Undo/Redo buttons work outside text fields
- [ ] The status shows Unsaved changes → Saving… → Saved · vN, with one `PUT` per pause (Network tab)
- [ ] A concurrent save in a second window opens the conflict dialog; Reload, Overwrite and Merge each behave as described
- [ ] A viewer sees the story read-only and never sends `PUT /doc`
- [ ] `npm test` (including the two autosave tests) and `npx tsc -b` pass
:::

:::quiz id=cap-06-q2 xp=15
Autosave triggers on `rev` (a local revision counter) instead of "the document object changed". Why?
- [ ] Comparing objects is too slow in JavaScript
- [x] Not every document change is a local edit this client should save — a reset from the server or (in cap-07) a collaborator's live change must not trigger a save from here
- [ ] `useEffect` cannot depend on objects
- [ ] The server requires a revision number in the request
> The document can change for reasons other than "I edited it". Counting local edits separately lets
> the editor accept outside changes without immediately saving them back, which would cause
> needless saves and conflicts between collaborators. Speed is the tempting answer, but it isn't
> the reason: the reducer already returns the same object for no-ops, so an identity check
> (`prev !== next`) is as cheap as comparing numbers. Identity just answers the wrong question,
> "did it change?" instead of "did *I* change it?".
:::

:::quiz id=cap-06-q5 xp=15
Spot the bug. A teammate "simplifies" the reducer:

```ts
case 'addNode':
  doc.nodes.push(action.node)
  return doc
```

What breaks?
- [ ] Nothing: `push` is faster than spreading into a new array
- [x] The canvas may not re-render, and the scene silently ends up in every undo snapshot that shares this array, so undo can't remove it
- [ ] TypeScript refuses to compile `push` on a readonly array
- [ ] Only autosave breaks, because `JSON.stringify` skips mutated arrays
> Returning the *same* object tells React and `historyReducer` "nothing changed", so no re-render,
> no history entry and no new `rev`, which means no autosave. Worse, `past` snapshots share the same `nodes`
> array, so the mutation rewrites history too. The TypeScript answer is tempting, but `StoryDoc`'s
> arrays aren't declared `readonly` here, so it compiles fine (marking them `readonly` *is* a good
> way to catch this bug). `JSON.stringify` serializes whatever the array holds right now.
:::

:::quiz id=cap-06-q3 xp=15
Window B gets a 409 with `currentVersion: 5`. The user picks **Overwrite with mine**. What must the next request contain?
- [ ] `PUT /doc` with `expectedVersion` unchanged — the server will accept it the second time
- [x] `PUT /doc` with B's document and `expectedVersion: 5`
- [ ] `PUT /doc` without `expectedVersion` so the check is skipped
- [ ] A `DELETE` of version 5 followed by a `POST`
> Overwrite is still an optimistic-concurrency save — just against the version the user has now
> *seen*. If someone saved v6 in the meantime, the overwrite is refused too, which is correct:
> the user never saw v6. Re-sending the old `expectedVersion` fails forever (the row will never be
> at that version again), and dropping it gets a 428 from cap-04, which refuses blind writes on
> purpose. That's why `resolveConflict('overwrite')` updates `versionRef` before calling `resume()`.
:::

:::quiz id=cap-06-q4 xp=15
Which choices make a safer conflict dialog? (Select all that apply.)
- [x] Initial focus on the non-destructive default (Merge)
- [x] Styling "Overwrite with mine" as dangerous
- [x] Escape does not silently pick an option
- [ ] Auto-closing after 10 seconds with "Overwrite"
> A conflict means someone's work is at stake. Defaults should never destroy data, and a dialog
> that decides by itself on a timer takes control away from the user.
:::

:::cards id=cap-06-cards1 xp=20 title="Editor architecture"
Q: Three rules of a reducer?
A: Pure (no I/O, no randomness, no time), never mutates its input, returns the same object when nothing changed.
Q: How does snapshot undo stay cheap?
A: Immutable updates share every unchanged node/edge object between snapshots; only changed paths are copied.
Q: What is coalescing in an undo history?
A: Consecutive actions with the same key (e.g. typing in one field) replace the present instead of adding a new step.
Q: Single-flight autosave?
A: At most one save in flight; edits made meanwhile are saved afterwards with the version the first save returned.
Q: Why stop autosave after a 409?
A: Every retry would carry the same stale version and fail; the user must choose reload, overwrite or merge.
Q: Three-way merge inputs?
A: Base (last saved/loaded), mine (local), theirs (server latest). Take the side that changed; both changed differently → conflict.
Q: Why validate on the client and on the server?
A: The client gives instant feedback; only the server can enforce rules (publish refuses an unplayable story).
Q: `rev` vs `version`?
A: `rev` counts local edits in this tab (drives autosave). `version` is the server's row version (sent as `expectedVersion`).
Q: What does debouncing do?
A: Every new edit restarts a timer; the save fires only after a quiet period, so a burst of typing is one request.
:::

## Recap

- The story document is a value changed only through a pure `storyReducer`; ids and other side effects come in through actions.
- `historyReducer` wraps it with snapshot undo/redo, coalesced typing and a local `rev` counter.
- `validateStory` (start exists, no dangling choices, every scene reachable) runs on every change via `useMemo`.
- `useAutosave` debounces, runs one save at a time, stops on 409, and exposes `resume` / `markSaved` for conflict resolution.
- The save mutation updates the query cache optimistically and rolls back on error.
- A 409 opens an accessible dialog: reload theirs, overwrite against the current version, or a three-way merge (focused by default).
