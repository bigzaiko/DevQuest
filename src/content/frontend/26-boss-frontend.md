---
id: fe-26
title: "Boss Fight: Design System + Project Board"
level: expert
minutes: 240
xp: 400
summary: Put the whole frontend track together — a mini design system and a production-grade "Project board" feature module with routing, server state, optimistic moves, 409 handling, tests and an accessibility gate.
---

This is the final exam of the frontend track. No new APIs. The job here is **integration**: taking
everything from the last dozen lessons and making it work together the way it does in a real SaaS
codebase, where the hard part is never one hook but the seams between them.

The boss has two halves:

1. **The lab (main fight).** You build a real Vite + React 19 + TypeScript app on your machine: a small
   design system plus one feature module, the **Project board** (columns, cards, drag-free keyboard-friendly
   moves). It must pass an acceptance checklist covering architecture, a11y, tests and resilience.
2. **Boss phases (in the browser).** Four hard challenges that isolate the trickiest pieces of the board
   so you can prove them against tests: the pure move algorithm, the optimistic move with 409 rollback,
   the accessible "New card" dialog, and a write-the-tests phase.

You can do them in either order. Many people warm up with the phases, then do the lab.

Budget honestly: the four browser phases take roughly an hour together; the lab is a **multi-session**
build of three to four hours (design system, then the board feature, then tests and CI). Commit after
each part so you can stop and pick up again.

## The target architecture

```text
src/
├── app/                      # app shell: providers, router, layout — may import anything below
│   ├── providers.tsx         # QueryClientProvider, AuthProvider, ThemeProvider
│   ├── router.tsx            # createBrowserRouter(...) — lazy routes per feature
│   └── RootLayout.tsx
├── modules/
│   └── project-board/        # ONE feature module
│       ├── components/       # Board.tsx, BoardColumn.tsx, CardItem.tsx, NewCardDialog.tsx
│       ├── hooks/            # useBoard.ts, useMoveCard.ts, useBoardRealtime.ts
│       ├── services/         # boardApi.ts — the only place that knows URLs and DTOs
│       ├── domain/           # moveCard.ts — pure functions, zero React
│       ├── types.ts
│       └── index.ts          # PUBLIC API: export { BoardPage } and the types others may use
├── ui/                       # design system: Button, Input, Badge, Spinner, Dialog, Tabs
│   ├── tokens.css            # CSS custom properties (light + dark)
│   └── index.ts
└── shared/                   # cn(), http client, error types — no React components
```

The dependency arrows only point one way: **`app` → `modules` → `ui` / `shared`**. `ui` never imports from
`modules`. One module never deep-imports another module's internals — only its `index.ts`. That rule is
what lets a team of eight work on six features without stepping on each other, and it's enforced by ESLint,
not by good intentions.

```text
  ┌──────────┐     ┌──────────────────────┐     ┌──────────┐
  │   app    │ ──▶ │ modules/project-board│ ──▶ │    ui    │
  │ (shell)  │     │  (feature module)    │     │ (design  │
  └──────────┘     └──────────────────────┘     │  system) │
        │                    │                   └──────────┘
        └────────────────────┴──────────────▶  shared (cn, http, errors)
```

### Where each piece of state lives

Getting this table right *is* most of the architecture:

| State | Owner | Why |
|---|---|---|
| Board columns + cards (from the API) | **TanStack Query** cache, key `['board', boardId]` | It's server state: cached, shared, refetched, invalidated |
| "Which card is being edited", dialog open | component `useState` | Local, ephemeral UI state |
| Current board id | **the URL** (`/projects/:projectId/board`) | Shareable, survives reload, back button works |
| Filter text | URL search params (`?q=login`) | Same reasons as above |
| Theme | Context + `localStorage` | App-wide, rarely changes |
| Signed-in user / tokens | Auth provider (OIDC lib or BFF cookie) | Never in `localStorage` as a raw token |
| Optimistic move in flight | TanStack Query `onMutate` snapshot | So `onError` can roll back precisely |

:::job title="This is the day-one picture"
Join a mature React team and you'll find almost exactly this: a design-system folder (or a separate
`@company/ui` package), feature folders with a public `index.ts`, TanStack Query for server data, the URL as
the source of truth for navigation state, and CI that runs Vitest, Playwright and an axe gate on every PR.
Being able to explain *why* each piece is where it is is what separates a mid-level from a senior candidate.
:::

## The domain: version numbers and moves

Why a version at all? Two people have the same board open. Alice moves "Fix login" to *Doing*; a second later Bob,
whose screen is still showing the old board, moves it to *Done*. Without a check, the last write silently wins and
Alice never learns her move was overwritten — a **lost update**. **Optimistic concurrency** prevents that without
locking anything: each card carries a `version` that the server increments on every write, every move sends the
version the client *last saw*, and the API (ASP.NET Core with an EF Core concurrency token, in the backend track)
refuses the write with **`409 Conflict`** if the stored version has moved on. Bob gets the 409, sees the fresh
board, and decides again.

:::info title="409 or 412?"
In this board the version travels in the **request body**, and a stale one is answered with `409 Conflict`. Some
APIs send it as an HTTP precondition instead — `If-Match: "3"` — and then a stale version is, per RFC 9110,
`412 Precondition Failed` (the backend concurrency lesson covers both). The UX is identical: treat 409 and 412
the same way in the client.
:::

```ts
// modules/project-board/types.ts
export type CardId = string
export type ColumnId = string

export interface Card { id: CardId; title: string; version: number }
export interface Column { id: ColumnId; title: string; wipLimit?: number; cardIds: CardId[] }
export interface Board { id: string; columns: Column[]; cards: Record<CardId, Card> }

export interface MoveCardInput { cardId: CardId; toColumnId: ColumnId; toIndex: number; version: number }
```

The algorithm that moves a card is a **pure function** in `domain/`. The component, the optimistic update and
the real-time handler (when *another* user's move arrives over SignalR) all reuse it. Write it once, test it
to death.

:::challenge id=fe-26-c1 lang=ts xp=80
title: Boss phase 1 — the pure move algorithm
Implement `moveCard(board, cardId, toColumnId, toIndex)` returning a **new** board:

- Remove `cardId` from its current column and insert it into `toColumnId` at `toIndex`.
  `toIndex` is the position in the target column **after** removal, clamped to `0 … length`.
- Moving within the same column reorders it.
- Throw `Error('Unknown card')` if no column contains the card, `Error('Unknown column')` if the target doesn't exist.
- Throw `Error('WIP limit reached')` when moving into a **different** column whose `cardIds.length` is already
  `>= wipLimit`.
- Never mutate the input. **Structural sharing:** columns that didn't change must be the *same object*
  (`toBe`) in the result, and `cards` must be the same object too. That's what lets `memo`'d columns skip
  re-rendering.

hint: Find the source column with `board.columns.find(c => c.cardIds.includes(cardId))`.
hint: Build the target's new `cardIds` from the source list *with the card removed* when it's the same column.
hint: `columns.map(c => c.id === source.id ? newSource : c.id === target.id ? newTarget : c)` keeps the other columns' identity.

```ts starter
type Card = { id: string; title: string; version: number }
type Column = { id: string; title: string; wipLimit?: number; cardIds: string[] }
type Board = { id: string; columns: Column[]; cards: Record<string, Card> }

export function moveCard(board: Board, cardId: string, toColumnId: string, toIndex: number): Board {
  const source = board.columns.find((c) => c.cardIds.includes(cardId))!
  const target = board.columns.find((c) => c.id === toColumnId)!
  source.cardIds.splice(source.cardIds.indexOf(cardId), 1)
  target.cardIds.splice(toIndex, 0, cardId)
  return board
}
```

```ts solution
type Card = { id: string; title: string; version: number }
type Column = { id: string; title: string; wipLimit?: number; cardIds: string[] }
type Board = { id: string; columns: Column[]; cards: Record<string, Card> }

export function moveCard(board: Board, cardId: string, toColumnId: string, toIndex: number): Board {
  const source = board.columns.find((c) => c.cardIds.includes(cardId))
  if (!source) throw new Error('Unknown card')
  const target = board.columns.find((c) => c.id === toColumnId)
  if (!target) throw new Error('Unknown column')

  const sourceIds = source.cardIds.filter((id) => id !== cardId)
  if (source.id === target.id) {
    const i = Math.max(0, Math.min(toIndex, sourceIds.length))
    const ids = [...sourceIds.slice(0, i), cardId, ...sourceIds.slice(i)]
    return { ...board, columns: board.columns.map((c) => (c.id === source.id ? { ...c, cardIds: ids } : c)) }
  }

  if (target.wipLimit !== undefined && target.cardIds.length >= target.wipLimit) throw new Error('WIP limit reached')
  const i = Math.max(0, Math.min(toIndex, target.cardIds.length))
  const targetIds = [...target.cardIds.slice(0, i), cardId, ...target.cardIds.slice(i)]
  return {
    ...board,
    columns: board.columns.map((c) =>
      c.id === source.id ? { ...c, cardIds: sourceIds } : c.id === target.id ? { ...c, cardIds: targetIds } : c,
    ),
  }
}
```

```ts tests
const mk = () => ({
  id: 'b1',
  cards: { a: { id: 'a', title: 'A', version: 1 }, b: { id: 'b', title: 'B', version: 1 }, c: { id: 'c', title: 'C', version: 1 }, d: { id: 'd', title: 'D', version: 1 } },
  columns: [
    { id: 'todo', title: 'To do', cardIds: ['a', 'b'] },
    { id: 'doing', title: 'Doing', wipLimit: 2, cardIds: ['c'] },
    { id: 'done', title: 'Done', cardIds: ['d'] },
  ],
})
const ids = (b: any, col: string) => b.columns.find((c: any) => c.id === col).cardIds

test('moves across columns at an index', () => {
  const b = moveCard(mk(), 'a', 'doing', 0)
  expect(ids(b, 'todo')).toEqual(['b'])
  expect(ids(b, 'doing')).toEqual(['a', 'c'])
})
test('clamps the index', () => {
  expect(ids(moveCard(mk(), 'a', 'done', 99), 'done')).toEqual(['d', 'a'])
  expect(ids(moveCard(mk(), 'a', 'done', -3), 'done')).toEqual(['a', 'd'])
})
test('reorders within the same column (index after removal)', () => {
  expect(ids(moveCard(mk(), 'a', 'todo', 1), 'todo')).toEqual(['b', 'a'])
  expect(ids(moveCard(mk(), 'b', 'todo', 0), 'todo')).toEqual(['b', 'a'])
})
test('does not mutate the input', () => {
  const b0 = mk()
  const snapshot = JSON.stringify(b0)
  moveCard(b0, 'a', 'doing', 1)
  moveCard(b0, 'a', 'todo', 1)
  expect(JSON.stringify(b0)).toBe(snapshot)
})
test('structural sharing: untouched columns and cards keep identity', () => {
  const b0 = mk()
  const b1 = moveCard(b0, 'a', 'doing', 0)
  expect(b1).not.toBe(b0)
  expect(b1.columns[2]).toBe(b0.columns[2])
  expect(b1.cards).toBe(b0.cards)
  expect(b1.columns[0]).not.toBe(b0.columns[0])
})
test('WIP limit applies to other columns only', () => {
  const b = moveCard(mk(), 'a', 'doing', 0) // doing now has 2
  expect(() => moveCard(b, 'b', 'doing', 0)).toThrow('WIP limit reached')
  expect(ids(moveCard(b, 'c', 'doing', 0), 'doing')).toEqual(['c', 'a'])
})
test('unknown card / column', () => {
  expect(() => moveCard(mk(), 'zzz', 'doing', 0)).toThrow('Unknown card')
  expect(() => moveCard(mk(), 'a', 'nowhere', 0)).toThrow('Unknown column')
})
```
:::

## Server state: the board query and the optimistic move

An **optimistic update** means the UI shows the result of an action *before* the server confirms it, betting that
it will succeed (most moves do). The user gets instant feedback instead of a 300 ms spinner per move; the price is
that you must be able to **undo** the guess cleanly when the bet loses.

In the lab you'll use TanStack Query. The canonical optimistic mutation has five steps, and every one of them
exists for a reason:

```ts
// modules/project-board/hooks/useMoveCard.ts
export function useMoveCard(boardId: string) {
  const qc = useQueryClient()
  const key = boardKeys.detail(boardId)          // ['board', boardId]

  return useMutation({
    mutationFn: (input: MoveCardInput) => boardApi.moveCard(boardId, input),

    // 1. Cancel in-flight refetches so they can't overwrite our optimistic state.
    // 2. Snapshot the current cache. 3. Write the optimistic board.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Board>(key)
      if (previous) qc.setQueryData(key, moveCard(previous, input.cardId, input.toColumnId, input.toIndex))
      return { previous }
    },

    // 4. Roll back to the exact snapshot. A conflict additionally tells the user what happened.
    onError: (err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
      if (err instanceof ApiError && (err.status === 409 || err.status === 412))
        toast.warning('Someone else moved this card. The board was refreshed.')
      else toast.error('Could not move the card. Try again.')
    },

    // 5. Success or failure: re-sync with the truth from the server.
    //    Return the promise so the mutation stays "pending" until the refetch is done.
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}
```

And the service, the **only** file that knows the URL and the HTTP details:

```ts
// modules/project-board/services/boardApi.ts
export const boardApi = {
  get: (boardId: string) => http.get<BoardDto>(`/api/boards/${boardId}`).then(toBoard),
  moveCard: (boardId: string, { cardId, toColumnId, toIndex, version }: MoveCardInput) =>
    http.post<{ version: number }>(`/api/boards/${boardId}/cards/${cardId}/move`,
      { toColumnId, toIndex, version }),   // the version we last saw — the concurrency check
}
```

Keeping URLs and DTO mapping (`toBoard`) here means components and hooks only ever see domain types. When the
backend renames a field, one file changes.

:::quiz id=fe-26-q1 xp=15
In the optimistic mutation above, why does `onMutate` call `cancelQueries` **before** writing the optimistic
board?
- [ ] To stop the mutation request from being sent twice
- [x] An in-flight refetch started earlier could resolve after the optimistic write and overwrite it with stale server data
- [ ] `setQueryData` throws if a query is fetching
- [ ] To clear the cache so the rollback snapshot is empty
> Without cancelling, a background refetch (window focus, an earlier invalidation) can land a moment later
> and snap the card back to its old column — then forward again after `onSettled`. The UI flickers and users
> think the move failed. Cancel, snapshot, write, roll back on error, invalidate when settled. The mutation request
> itself is unaffected — `cancelQueries` only touches *queries* for that key, and `setQueryData` never throws.
:::

:::quiz id=fe-26-q5 xp=15
The move **succeeded** and the optimistic board already shows the card in its new column. Why does `onSettled`
still invalidate the board query?
- [ ] To roll back the optimistic write in case the server was slow
- [x] The optimistic board is only the client's guess; the server may have changed more (new version, positions, other users' moves), so refetch the truth
- [ ] Because TanStack Query discards `setQueryData` writes once a mutation finishes
- [ ] It isn't needed — invalidating after a successful mutation is a wasted request
> The client computed the new board *itself*. The server is the source of truth: it bumps the card's `version`,
> may renumber positions, and may have accepted other people's moves in the meantime. One cheap refetch replaces
> the guess with reality. Rolling back is `onError`'s job, and `setQueryData` writes persist until something
> replaces them — which is exactly what the refetch does.
:::

Now prove you can do the same thing **without** a library — which is exactly what you'll need to debug when
the library does something surprising.

:::challenge id=fe-26-c2 lang=tsx xp=100 preview=BoardDemo
title: Boss phase 2 — optimistic move with 409 rollback
`Board` receives `initial` (columns + cards) and an `api` with `moveCard(input) => Promise<{ version }>`.
Each card renders a button named `Move <title> right` (moves to the next column, index 0 — **not** rendered
in the last column). Columns are `<section aria-label={column.title}>`.

Behaviour:

1. **Optimistic:** the card appears in the next column **immediately**, before the API answers.
2. Call `api.moveCard({ cardId, toColumnId, version })` with the card's **current** version.
3. On success, store the returned `version` on the card (the next move must send it).
4. On failure, **roll back** to the board as it was before the move and show a `role="alert"`:
   - error with `status === 409` → `Someone else changed this card. Your move was undone.`
   - anything else → `Move failed. Try again.`
5. A successful move clears any alert.

`BoardDemo` and the data are provided in `setup`.

hint: Keep the whole board in one `useState`. Before moving, `const previous = board` — that's your snapshot.
hint: Make the move with a functional update: `setBoard(b => ({ ...b, columns: b.columns.map(...) }))`.
hint: `try { const { version } = await api.moveCard(...) } catch (e) { setBoard(previous); setError(...) }`.

```tsx setup
type Card = { id: string; title: string; version: number }
type Column = { id: string; title: string; cardIds: string[] }
type BoardData = { columns: Column[]; cards: Record<string, Card> }
type MoveInput = { cardId: string; toColumnId: string; version: number }
type BoardApi = { moveCard: (input: MoveInput) => Promise<{ version: number }> }

function sampleBoard(): BoardData {
  return {
    cards: { c1: { id: 'c1', title: 'Fix login', version: 3 }, c2: { id: 'c2', title: 'Write docs', version: 1 } },
    columns: [
      { id: 'todo', title: 'To do', cardIds: ['c1', 'c2'] },
      { id: 'doing', title: 'Doing', cardIds: [] },
      { id: 'done', title: 'Done', cardIds: [] },
    ],
  }
}

const demoApi: BoardApi = {
  moveCard: (input) =>
    new Promise((resolve, reject) =>
      setTimeout(() => (Math.random() < 0.3 ? reject({ status: 409 }) : resolve({ version: input.version + 1 })), 600),
    ),
}

function BoardDemo() {
  return <Board initial={sampleBoard()} api={demoApi} />
}
```

```tsx starter
import { useState } from 'react'

export function Board({ initial, api }: { initial: BoardData; api: BoardApi }) {
  const [board, setBoard] = useState(initial)

  function moveRight(cardId: string, fromIndex: number) {
    const to = board.columns[fromIndex + 1]
    setBoard({
      ...board,
      columns: board.columns.map((c, i) =>
        i === fromIndex ? { ...c, cardIds: c.cardIds.filter((id) => id !== cardId) } : c.id === to.id ? { ...c, cardIds: [cardId, ...c.cardIds] } : c,
      ),
    })
  }

  return (
    <div className="board">
      {board.columns.map((col, ci) => (
        <section key={col.id} aria-label={col.title}>
          <h2>{col.title}</h2>
          <ul>
            {col.cardIds.map((id) => {
              const card = board.cards[id]
              return (
                <li key={id}>
                  {card.title}
                  {ci < board.columns.length - 1 && (
                    <button onClick={() => moveRight(id, ci)}>Move {card.title} right</button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

export function Board({ initial, api }: { initial: BoardData; api: BoardApi }) {
  const [board, setBoard] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  async function moveRight(cardId: string, fromIndex: number) {
    const previous = board
    const to = board.columns[fromIndex + 1]
    setBoard({
      ...board,
      columns: board.columns.map((c, i) =>
        i === fromIndex ? { ...c, cardIds: c.cardIds.filter((id) => id !== cardId) } : c.id === to.id ? { ...c, cardIds: [cardId, ...c.cardIds] } : c,
      ),
    })
    try {
      const { version } = await api.moveCard({ cardId, toColumnId: to.id, version: board.cards[cardId].version })
      setBoard((b) => ({ ...b, cards: { ...b.cards, [cardId]: { ...b.cards[cardId], version } } }))
      setError(null)
    } catch (e) {
      setBoard(previous)
      setError((e as { status?: number })?.status === 409 ? 'Someone else changed this card. Your move was undone.' : 'Move failed. Try again.')
    }
  }

  return (
    <div className="board">
      {error && <p role="alert">{error}</p>}
      {board.columns.map((col, ci) => (
        <section key={col.id} aria-label={col.title}>
          <h2>{col.title}</h2>
          <ul>
            {col.cardIds.map((id) => {
              const card = board.cards[id]
              return (
                <li key={id}>
                  {card.title}
                  {ci < board.columns.length - 1 && (
                    <button onClick={() => moveRight(id, ci)}>Move {card.title} right</button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
```

```tsx tests
function deferred() {
  let resolve: (v: any) => void = () => {}
  let reject: (e: any) => void = () => {}
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {}) // a rejection nobody awaits must not crash the test run
  return { promise, resolve, reject }
}

test('moves optimistically before the API answers, and sends the current version', async () => {
  const d = deferred()
  const api = { moveCard: fn(() => d.promise) }
  render(<Board initial={sampleBoard()} api={api as any} />)
  await user.click(screen.getByRole('button', { name: 'Move Fix login right' }))
  expect(screen.getByRole('region', { name: 'Doing' })).toHaveTextContent('Fix login')
  expect(screen.getByRole('region', { name: 'To do' })).not.toHaveTextContent('Fix login')
  expect(api.moveCard).toHaveBeenCalledWith({ cardId: 'c1', toColumnId: 'doing', version: 3 })
  await act(async () => { d.resolve({ version: 4 }) })
  expect(screen.getByRole('region', { name: 'Doing' })).toHaveTextContent('Fix login')
})

test('the next move sends the version returned by the server', async () => {
  const api = { moveCard: fn((input: any) => Promise.resolve({ version: input.version + 10 })) }
  render(<Board initial={sampleBoard()} api={api as any} />)
  await user.click(screen.getByRole('button', { name: 'Move Fix login right' }))
  await waitFor(() => expect(api.moveCard).toHaveBeenCalledTimes(1))
  await act(async () => { await Promise.resolve() })
  await user.click(screen.getByRole('button', { name: 'Move Fix login right' }))
  expect(api.moveCard).toHaveBeenCalledWith({ cardId: 'c1', toColumnId: 'done', version: 13 })
  expect(screen.getByRole('region', { name: 'Done' })).toHaveTextContent('Fix login')
  expect(screen.queryByRole('button', { name: 'Move Fix login right' })).toBeNull()
})

test('a 409 rolls back and explains the conflict', async () => {
  const d = deferred()
  const api = { moveCard: fn(() => d.promise) }
  render(<Board initial={sampleBoard()} api={api as any} />)
  await user.click(screen.getByRole('button', { name: 'Move Fix login right' }))
  await act(async () => { d.reject({ status: 409 }) })
  expect(screen.getByRole('region', { name: 'To do' })).toHaveTextContent('Fix login')
  expect(screen.getByRole('region', { name: 'Doing' })).not.toHaveTextContent('Fix login')
  expect(screen.getByRole('alert')).toHaveTextContent('Someone else changed this card. Your move was undone.')
})

test('other errors roll back with a generic message, success clears it', async () => {
  let fail = true
  const api = { moveCard: fn(() => (fail ? Promise.reject(new Error('network')) : Promise.resolve({ version: 2 }))) }
  render(<Board initial={sampleBoard()} api={api as any} />)
  await user.click(screen.getByRole('button', { name: 'Move Write docs right' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Move failed. Try again.')
  expect(screen.getByRole('region', { name: 'To do' })).toHaveTextContent('Write docs')
  fail = false
  await user.click(screen.getByRole('button', { name: 'Move Write docs right' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByRole('region', { name: 'Doing' })).toHaveTextContent('Write docs')
})
```
:::

:::warn title="The snapshot bug you'll meet in the wild"
`const previous = board` captures the board **at click time**. If two moves are in flight and the *first*
fails, rolling back to its snapshot also undoes the *second* (still-pending) move. Libraries handle this by
cancelling and invalidating (`onSettled` refetch puts the truth back) — and for real-time boards, by
re-applying pending local operations on top of the server state. Know the limitation; mention it in review.
:::

## The 409 UX: what should the user see?

A conflict is not an error in the "something broke" sense — it's **two humans disagreeing**. Good products
treat it that way:

- **Card moves** (small, idempotent-ish): roll back, refetch, show a non-blocking toast. The user simply
  tries again with fresh data.
- **Text edits** (a card description someone spent five minutes on): **never** discard the user's text.
  Show "Someone else edited this card" with *Keep mine (overwrite)*, *Use theirs*, or a field-level merge —
  the three-way merge from the real-time lesson.
- **Destructive actions** on stale data (delete a card that was just reassigned): block and reload.

:::quiz id=fe-26-q2 xp=15
A user spends several minutes editing a card's description; on save the API answers **409**. Which responses
are acceptable? (Select all that apply.)
- [x] Keep their draft, show the server's newer version, and offer "Overwrite" / "Use theirs"
- [ ] Silently reload the card from the server, replacing the draft
- [x] Auto-merge if the other user changed different fields, otherwise ask
- [ ] Retry the same PUT with the same stale `version` until it succeeds
- [ ] Drop the `version` from the request so the save always succeeds
> Silently dropping the draft destroys work; retrying with the same stale version will 409 forever; removing
> the version turns optimistic concurrency into "last write wins" and quietly loses the other person's edit.
> Preserve the draft and give the human the decision (or merge when it's provably safe).
:::

## Accessibility is part of "done"

The board must be fully usable with a keyboard and a screen reader. Drag-and-drop alone fails WCAG 2.2
**2.5.7 Dragging Movements**: there must be a single-pointer, non-drag alternative. That's why our cards have
"Move right" buttons (or a "Move to…" menu). Other requirements you'll check in the lab:

- Columns are labelled regions; cards are list items; counts are announced (`aria-label="Doing, 2 cards"`).
- Dialogs: `role="dialog"`, `aria-modal`, labelled by their heading, focus moves in on open, is trapped,
  Escape closes, focus returns to the trigger.
- Form errors are connected with `aria-describedby` and flagged with `aria-invalid`.
- Live feedback (moves, conflicts) goes through a `role="status"` / `role="alert"` region.
- Colour contrast meets 4.5:1 in **both** themes — your design tokens make this a one-file fix.

:::challenge id=fe-26-c3 lang=tsx xp=100 preview=NewCardButton
title: Boss phase 3 — the accessible "New card" dialog
Build `NewCardButton({ onCreate })`:

- A button `New card` opens a dialog: an element with `role="dialog"`, `aria-modal="true"` and
  `aria-labelledby` pointing at an `h2` reading `Create card`.
- On open, focus moves to the text input labelled `Title`.
- **Escape** closes the dialog; a `Cancel` button closes it too. After closing, focus returns to `New card`.
- The form submits with the `Create` button or Enter in the input. An empty/whitespace title shows
  `Title is required` (with an `id`), sets `aria-invalid="true"` on the input and points its
  `aria-describedby` at the error. The dialog stays open.
- A valid title calls `onCreate({ title })` with the trimmed title, closes the dialog and returns focus.

hint: `const titleRef = useRef<HTMLInputElement>(null)` + `useEffect(() => { if (open) titleRef.current?.focus() }, [open])`.
hint: Return focus in a `close()` helper: `setOpen(false); triggerRef.current?.focus()` — the trigger stays mounted, so this works.
hint: `const errorId = useId()` gives you a stable id for `aria-describedby`.

```tsx starter
import { useEffect, useId, useRef, useState } from 'react'

export function NewCardButton({ onCreate }: { onCreate: (card: { title: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  return (
    <>
      <button onClick={() => setOpen(true)}>New card</button>
      {open && (
        <div className="dialog">
          <h2>Create card</h2>
          <form onSubmit={(e) => { e.preventDefault(); onCreate({ title }); setOpen(false) }}>
            <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <button type="submit">Create</button>
          </form>
        </div>
      )}
    </>
  )
}
```

```tsx solution
import { useEffect, useId, useRef, useState } from 'react'

export function NewCardButton({ onCreate }: { onCreate: (card: { title: string }) => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const errorId = useId()
  const inputId = useId()

  useEffect(() => {
    if (open) titleRef.current?.focus()
  }, [open])

  function close() {
    setOpen(false)
    setTitle('')
    setError(null)
    triggerRef.current?.focus()
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) {
      setError('Title is required')
      return
    }
    onCreate({ title: t })
    close()
  }

  return (
    <>
      <button ref={triggerRef} onClick={() => setOpen(true)}>New card</button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}
        >
          <h2 id={headingId}>Create card</h2>
          <form onSubmit={submit} noValidate>
            <label htmlFor={inputId}>Title</label>
            <input
              id={inputId}
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {error && <p id={errorId}>{error}</p>}
            <button type="button" onClick={close}>Cancel</button>
            <button type="submit">Create</button>
          </form>
        </div>
      )}
    </>
  )
}
```

```tsx tests
async function openDialog() {
  await user.click(screen.getByRole('button', { name: 'New card' }))
  return screen.getByRole('dialog', { name: 'Create card' })
}

test('opens a labelled modal dialog and focuses the title', async () => {
  render(<NewCardButton onCreate={fn()} />)
  const dialog = await openDialog()
  expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(screen.getByLabelText('Title')).toHaveFocus()
})

test('Escape closes and returns focus to the trigger', async () => {
  render(<NewCardButton onCreate={fn()} />)
  await openDialog()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'New card' })).toHaveFocus()
})

test('Cancel closes without creating', async () => {
  const onCreate = fn()
  render(<NewCardButton onCreate={onCreate} />)
  await openDialog()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onCreate).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'New card' })).toHaveFocus()
})

test('empty title shows a connected error and keeps the dialog open', async () => {
  const onCreate = fn()
  render(<NewCardButton onCreate={onCreate} />)
  await openDialog()
  await user.type(screen.getByLabelText('Title'), '   ')
  await user.click(screen.getByRole('button', { name: 'Create' }))
  const input = screen.getByLabelText('Title')
  const error = screen.getByText('Title is required')
  expect(onCreate).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(error.id).toBeTruthy()
  expect(input).toHaveAttribute('aria-describedby', error.id)
})

test('Enter submits a trimmed title, closes and returns focus', async () => {
  const onCreate = fn()
  render(<NewCardButton onCreate={onCreate} />)
  await openDialog()
  await user.type(screen.getByLabelText('Title'), '  Ship it {Enter}')
  expect(onCreate).toHaveBeenCalledWith({ title: 'Ship it' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: 'New card' })).toHaveFocus()
})
```
:::

## Phase 4: you are the reviewer

The board's column view lets users reorder cards with **Alt + ↑ / ↓**, backed by a tiny `reorder()` helper.
Someone on your team wrote it. Before you approve the PR, you write the tests that would catch the
classic bugs: mutating the input, mishandling out-of-range indices, and forgetting to clamp.

:::challenge id=fe-26-c4 lang=ts mode=tests xp=80
title: Boss phase 4 — test `reorder` like a senior reviewer
`reorder(list, from, to)` returns a **new** array with the item at `from` moved to position `to`
(positions counted after removal, clamped to the valid range). An out-of-range `from` returns an unchanged
**copy**. Write tests that pass on this implementation and catch every hidden buggy version.

hint: Check that the original array is unchanged after the call — and that the result is a different array.
hint: Try `to = -1` and `to` far beyond the end.
hint: Try `from` equal to `list.length` — exactly one past the last valid index.

```ts impl
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice()
  if (from < 0 || from >= list.length) return copy
  const [item] = copy.splice(from, 1)
  const target = Math.max(0, Math.min(to, copy.length))
  copy.splice(target, 0, item)
  return copy
}
```

```ts mutant
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const copy = list
  if (from < 0 || from >= list.length) return copy.slice()
  const [item] = copy.splice(from, 1)
  const target = Math.max(0, Math.min(to, copy.length))
  copy.splice(target, 0, item)
  return copy.slice()
}
```

```ts mutant
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice()
  if (from < 0 || from >= list.length) return copy
  const [item] = copy.splice(from, 1)
  copy.splice(to, 0, item)
  return copy
}
```

```ts mutant
export function reorder<T>(list: T[], from: number, to: number): T[] {
  const copy = list.slice()
  if (from < 0 || from > list.length) return copy
  const [item] = copy.splice(from, 1)
  const target = Math.max(0, Math.min(to, copy.length))
  copy.splice(target, 0, item)
  return copy
}
```

```ts mutant
export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list
  const copy = list.slice()
  const [item] = copy.splice(from, 1)
  const target = Math.max(0, Math.min(to, copy.length))
  copy.splice(target, 0, item)
  return copy
}
```

```ts starter
test('moves the first item to the end', () => {
  expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
})
```

```ts solution
test('moves forward and backward', () => {
  expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
})
test('does not mutate the input', () => {
  const list = ['a', 'b', 'c']
  reorder(list, 0, 2)
  expect(list).toEqual(['a', 'b', 'c'])
})
test('clamps negative and too-large targets', () => {
  expect(reorder(['a', 'b', 'c'], 2, -1)).toEqual(['c', 'a', 'b'])
  expect(reorder(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
})
test('out-of-range from returns an unchanged copy', () => {
  const list = ['a', 'b']
  const out = reorder(list, 2, 0)
  expect(out).toEqual(['a', 'b'])
  expect(out).not.toBe(list)
  expect(reorder(list, -1, 0)).toEqual(['a', 'b'])
})
```
:::

## The main fight: build it

:::lab id=fe-26-lab1 xp=250
title: Boss lab — design system + Project board feature module
You'll build a complete, production-shaped frontend. Budget **6–10 hours** over several sessions; commit after
each milestone. Use a fake backend (`json-server` or MSW) or the ASP.NET API from the backend track.

### 0. Scaffold

```bash
npm create vite@latest project-board -- --template react-ts
cd project-board
npm i react-router @tanstack/react-query clsx tailwind-merge
npm i -D tailwindcss @tailwindcss/vite vitest jsdom @testing-library/react @testing-library/user-event \
  @testing-library/jest-dom @playwright/test @axe-core/playwright msw eslint-plugin-boundaries
npx playwright install --with-deps chromium
```

Create the folder structure from the top of this lesson (`app/`, `modules/project-board/`, `ui/`, `shared/`).

### 1. Design system (`src/ui`)

Add the Tailwind plugin to `vite.config.ts` (`import tailwindcss from '@tailwindcss/vite'`, then
`plugins: [react(), tailwindcss()]`) and import `./ui/tokens.css` once in `main.tsx`.

`src/ui/tokens.css` — semantic tokens, both themes, wired into Tailwind v4. Components never use raw colours
like `bg-blue-600`; they use *semantic* names (`bg-primary`, `text-fg`), so a theme is just a different set of
values for the same names:

```css
@import "tailwindcss";

/* Make Tailwind's dark: variant follow data-theme instead of the OS setting */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

/* 1. Raw theme values (plain CSS variables, switched by data-theme) */
:root {
  --bg: oklch(98% 0.01 250);
  --surface: oklch(100% 0 0);
  --text: oklch(25% 0.02 250);
  --muted: oklch(50% 0.02 250);
  --primary: oklch(55% 0.18 260);
  --primary-fg: oklch(99% 0 0);
  --danger: oklch(55% 0.2 25);
  --radius: 0.5rem;
}
[data-theme="dark"] {
  --bg: oklch(18% 0.02 250);
  --surface: oklch(24% 0.02 250);
  --text: oklch(94% 0.01 250);
  --muted: oklch(72% 0.02 250);
  --primary: oklch(72% 0.15 260);
  --primary-fg: oklch(18% 0.02 250);
  --danger: oklch(70% 0.18 25);
}

/* 2. Expose them to Tailwind as utilities: bg-bg, bg-surface, text-fg, text-muted, bg-primary, rounded-md … */
@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-fg: var(--text);
  --color-muted: var(--muted);
  --color-primary: var(--primary);
  --color-primary-fg: var(--primary-fg);
  --color-danger: var(--danger);
  --radius-md: var(--radius);
}
```

`inline` tells Tailwind to put `var(--primary)` straight into the generated utility, so the value is resolved
where the class is used — under `[data-theme="dark"]` it picks up the dark value. (Common mistake: naming the raw
variable `--color-primary` *and* mapping `--color-primary: var(--color-primary)` in `@theme` — a variable that
refers to itself is confusing at best and an invalid, cyclic value at worst. Keep the two layers' names distinct.)

Then build, each in its own file with a colocated test:

- `Button` — `variant: 'primary' | 'secondary' | 'ghost' | 'danger'`, `size: 'sm' | 'md'`, `loading`
  (shows `Spinner`, sets `aria-busy`, disables), defaults `type="button"`, spreads rest props, accepts `ref`.
- `Input` — `label`, `error`, `hint`; uses `useId`, `aria-invalid`, `aria-describedby`.
- `Badge`, `Spinner` (`role="status"` + visually hidden text).
- `Dialog` — native `<dialog>` with `showModal()` (free focus trap + Escape + inert background), labelled
  by its title, returns focus to the opener. Heads-up: **jsdom doesn't implement `showModal()`**, so component
  tests need a tiny stub in `setup.ts`
  (`HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }`, and a `close` that
  removes the attribute)
  — and the real focus behaviour is verified in Playwright, which runs a real browser.
- `src/ui/index.ts` exports only the public components and their prop types.

### 2. Feature module (`src/modules/project-board`)

- `types.ts` — `Board`, `Column`, `Card`, `MoveCardInput` (from this lesson).
- `domain/moveCard.ts` — your Boss phase 1 solution, with its tests in `moveCard.test.ts`.
- `services/boardApi.ts` — `get`, `moveCard` (sends the card's `version`), `createCard`; maps DTOs to domain types and
  throws an `ApiError` with `status` for non-2xx responses.
- `hooks/useBoard.ts` — `useQuery({ queryKey: boardKeys.detail(id), queryFn: () => boardApi.get(id), staleTime: 30_000 })`.
- `hooks/useMoveCard.ts` — the optimistic mutation from this lesson (cancel → snapshot → write → rollback → invalidate).
- `components/` — `BoardPage` (reads `projectId` from the route), `BoardColumn` (memoised), `CardItem`
  (with "Move left/right" buttons), `NewCardDialog`.
- `index.ts` — exports `BoardPage` and the public types **only**.

### 3. App shell (`src/app`)

```tsx
// src/app/router.tsx
import { createBrowserRouter } from 'react-router'
import { RootLayout } from './RootLayout'
import { NotFound, ProjectsHome } from './pages'   // small pages you write yourself

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    errorElement: <NotFound />,
    children: [
      { index: true, element: <ProjectsHome /> },
      {
        path: 'projects/:projectId/board',
        lazy: async () => ({ Component: (await import('../modules/project-board')).BoardPage }),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
])
```

`providers.tsx` stacks `QueryClientProvider` (with `retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2`)
and a `ThemeProvider` that writes `data-theme` on `<html>`. Wrap the board route in a `RequireAuth`
guard (a fake auth context is fine here; the security lesson covered the real OIDC + PKCE flow).

### 4. Enforce the architecture

Add `eslint-plugin-boundaries` (or `no-restricted-imports`) rules so that:

- `ui/**` cannot import from `modules/**` or `app/**`,
- `modules/*` can import another module only through its `index.ts`,
- `shared/**` imports nothing from `ui`, `modules` or `app`.

ESLint's built-in `no-restricted-imports` is enough to start. Add a `@/` alias for `src/` (`resolve.alias` in
`vite.config.ts` plus `"paths": { "@/*": ["./src/*"] }` in `tsconfig.app.json`), use it for every import that
crosses a top-level folder, and add to the flat config in `eslint.config.js`:

```js
const layer = (files, patterns) => ({ files, rules: { 'no-restricted-imports': ['error', { patterns }] } })

export default [
  // …the template's existing config…
  layer(['src/ui/**'], [{ group: ['@/modules/**', '@/app/**'], message: 'ui must not depend on features or the app shell' }]),
  layer(['src/shared/**'], [{ group: ['@/ui/**', '@/modules/**', '@/app/**'], message: 'shared must stay framework-free' }]),
  layer(['src/modules/**'], [{ group: ['@/modules/*/**'], message: 'Import other modules via their index: @/modules/<name>' }]),
]
```

`@/modules/*/**` matches `@/modules/project-board/components/CardItem` but not `@/modules/project-board`, which is
exactly "public API only" (inside its own module, code uses relative imports, which the rule ignores).
(`eslint-plugin-boundaries` does the same with element types and also catches
*relative* paths like `../../project-board/…`, which this simple version misses.)

Prove it: add a forbidden import, see `npm run lint` fail, remove it.

### 5. Tests

Vitest reads its settings from `vite.config.ts` (import `defineConfig` from `'vitest/config'` instead of `'vite'`
so the `test` key is typed):

```ts
// vite.config.ts (excerpt)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
})
```

`src/test/setup.ts` imports `@testing-library/jest-dom/vitest`, adds the `<dialog>` stub, unmounts rendered trees
after each test and starts the MSW server. This config leaves Vitest's `globals` off, so import the hooks yourself.
React Testing Library only cleans up on its own when a global `afterEach` exists. Without one, every test's DOM
stays mounted, and later `getByRole` calls fail with *Found multiple elements*:

```ts
// src/test/setup.ts (excerpt)
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import { server } from './server'   // exports setupServer(...handlers) from 'msw/node'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => { cleanup(); server.resetHandlers() })
afterAll(() => server.close())
```

(The alternative is `globals: true` in the `test` block plus `"types": ["vitest/globals"]` in `tsconfig.app.json`.)
The `include` keeps Vitest away from the Playwright files in `e2e/`. Write at least:

- unit tests for `moveCard` and `reorder` (your Boss phases 1 and 4),
- component tests for `Button`, `Input` and `NewCardDialog` (query by role / label only),
- an integration test rendering `BoardPage` inside a fresh `QueryClient` + `createMemoryRouter`, with MSW
  returning a board, asserting the optimistic move and the **409 rollback** (`http.post(..., () => HttpResponse.json({}, { status: 409 }))`).

Then the end-to-end suite with an axe gate. `playwright.config.ts` starts the dev server for you:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',   // if MSW's browser worker runs in dev, page.route() would never see the requests
  },
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI },
})
```

```ts
// e2e/board.spec.ts — boardFixture is the board for project p1 (one card "Fix login", version 1, in "To do");
// movedBoardFixture is the same board after the move ("Fix login", version 2, in "Doing")
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { boardFixture, movedBoardFixture } from './fixtures'

test.beforeEach(async ({ page }) => {
  // '*' matches exactly one path segment, so this doesn't catch the /cards/…/move URL
  await page.route('**/api/boards/*', (route) => route.fulfill({ json: boardFixture }))
})

test('moves a card with the keyboard', async ({ page }) => {
  // A stateful fake backend: once the move is accepted, the onSettled refetch must return the moved board,
  // or the card would snap back and the test would only pass by catching the brief optimistic state.
  let moved = false
  await page.route('**/api/boards/*', (route) => route.fulfill({ json: moved ? movedBoardFixture : boardFixture }))
  await page.route('**/api/boards/*/cards/*/move', (route) => {
    moved = true
    return route.fulfill({ json: { version: 2 } })
  })
  await page.goto('/projects/p1/board')
  const doing = page.getByRole('region', { name: /Doing/ })
  const moveRequest = page.waitForRequest('**/api/boards/*/cards/*/move')
  await page.getByRole('button', { name: 'Move Fix login right' }).focus()
  await page.keyboard.press('Enter')
  expect((await moveRequest).postDataJSON()).toMatchObject({ toColumnId: 'doing', version: 1 })
  await expect(doing).toContainText('Fix login')
})

test('shows a conflict message on 409 and rolls back', async ({ page }) => {
  await page.route('**/api/boards/*/cards/*/move', (route) => route.fulfill({ status: 409, json: {} }))
  await page.goto('/projects/p1/board')
  await page.getByRole('button', { name: 'Move Fix login right' }).click()
  await expect(page.getByRole('alert')).toContainText('Someone else')
  await expect(page.getByRole('region', { name: /To do/ })).toContainText('Fix login')
})

for (const theme of ['light', 'dark']) {
  test(`board has no serious a11y violations (${theme})`, async ({ page }) => {
    await page.goto('/projects/p1/board')
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    // axe tags are per WCAG version: list 2.0, 2.1 and 2.2 to get every A/AA rule
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  })
}
```

### 6. CI

A GitHub Actions workflow running `npm ci`, `npm run lint`, `npx tsc -b`, `npx vitest run`, `npm run build`
and `npx playwright test` (uploading the trace/report artifact on failure):

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npx tsc -b
      - run: npx vitest run
      - run: npm run build
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
```

:::pro title="How a senior would present this"
Open a PR per milestone with a short description: *what*, *why*, *how to test*, screenshots in both themes.
Reviewers love seeing the dependency rule enforced by lint, the 409 path covered by an integration test, and
an axe run in CI — those three things show you think about the team, not just the feature.
:::

- [ ] Folder structure matches `app/ → modules/ → ui/ + shared/`; `modules/project-board/index.ts` is the only import path used by `app/`
- [ ] A forbidden import (e.g. `ui` → `modules`) makes `npm run lint` fail
- [ ] `Button`, `Input`, `Badge`, `Spinner`, `Dialog` exist with typed props, rest-prop spreading and colocated tests
- [ ] Light and dark themes switch via `data-theme` on `<html>`; every colour comes from a token
- [ ] `/projects/:projectId/board` loads lazily; unknown URLs show a 404 page; the board route is behind an auth guard
- [ ] The board loads with TanStack Query and shows loading and error states
- [ ] Moving a card is optimistic, sends the card's `version`, rolls back on failure and shows a conflict message on 409
- [ ] Every action works with the keyboard alone (no drag-only interactions); the New card dialog traps and returns focus
- [ ] `npx vitest run` is green, including the MSW integration test for the 409 rollback
- [ ] `npx playwright test` is green, including the axe gate in both themes
- [ ] CI runs lint, type-check, unit tests, build and e2e on every push
:::

## Final review questions

:::quiz id=fe-26-q3 xp=15
A teammate's PR adds `import { CardItem } from '../project-board/components/CardItem'` inside
`modules/sprint-planning`. What's the right review comment?
- [ ] Approve — it's the same repo, so the import is fine
- [x] Request that `CardItem` be exported from `project-board/index.ts` (or promoted to `ui/` if it's generic) and imported from there
- [ ] Ask them to copy-paste `CardItem` into `sprint-planning`
- [ ] Move all components into one shared `components/` folder
> Deep imports couple one module to another's internals, so a refactor inside `project-board` silently breaks
> `sprint-planning`. Either make it part of the module's public API, or — if it has no board-specific logic —
> promote it to the design system. Copy-paste duplicates bugs; one big folder throws away the architecture.
:::

:::quiz id=fe-26-q4 xp=15
Where should each piece live? Pick the **correct** pairs. (Select all that apply.)
- [x] The selected `projectId` → the URL path
- [ ] The list of cards fetched from the API → a React Context with `useState`
- [x] Whether the "New card" dialog is open → local `useState` in the component that owns the dialog
- [x] The card-move snapshot for rollback → the mutation's `onMutate` context
- [ ] The OIDC access token → `localStorage` so it survives reloads
> Navigation state belongs in the URL, server data in the query cache, ephemeral UI state locally, and rollback
> snapshots in the mutation context. Tokens in `localStorage` are readable by any XSS payload — keep them in
> memory (OIDC library) or out of JavaScript entirely (BFF with an HttpOnly cookie).
:::

## Recap

- Architecture is about **seams**: `app → modules → ui/shared`, public `index.ts` per module, enforced by lint.
- Put state where it belongs: **URL** for navigation, **query cache** for server data, **local state** for
  ephemeral UI, **context** for rare app-wide values.
- Keep domain logic (moving cards, merging, reordering) in **pure functions** with structural sharing — the UI,
  optimistic updates and real-time handlers all reuse them.
- Optimistic updates: **cancel → snapshot → write → roll back on error → invalidate when settled**.
- A **409** is a human conflict: roll back and refresh small actions; never discard a user's draft.
- "Done" includes keyboard access, labelled dialogs with focus management, connected form errors, both themes
  passing contrast, unit + integration + e2e tests, and an **axe gate** in CI.

:::cards id=fe-26-cards1 xp=20 title="Boss fight review"
Q: What are the dependency rules of the target architecture?
A: `app` → `modules` → `ui` / `shared`. `ui` never imports features; modules import each other only via `index.ts`.
Q: The five steps of an optimistic mutation?
A: Cancel in-flight queries, snapshot the cache, write the optimistic value, roll back to the snapshot on error, invalidate on settle.
Q: Why structural sharing in `moveCard`?
A: Unchanged columns keep their identity, so memoised components skip re-rendering and `Object.is` checks stay cheap.
Q: What does the move request's `version` do, and what does a 409 mean?
A: It's the version the client last saw. 409: the card changed since — someone else wrote first. (With `If-Match: "<version>"` the same situation is a 412.)
Q: Why must a drag-and-drop board also offer buttons or a menu?
A: WCAG 2.2 SC 2.5.7 Dragging Movements — every drag action needs a single-pointer, non-drag alternative (and keyboard users need it anyway).
Q: Accessible dialog checklist?
A: `role="dialog"` + `aria-modal`, labelled by its heading, focus in on open, focus trapped, Escape closes, focus returns to the trigger.
Q: Where does the selected board id live, and why?
A: In the URL — shareable, bookmarkable, survives reloads, and the back button works.
:::
