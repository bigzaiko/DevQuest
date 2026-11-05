# DevQuest lesson format

Every lesson is one Markdown file in `src/content/<track>/NN-slug.md`.
Files are ordered by their filename (`01-…`, `02-…`). A new folder plus an
entry in `src/content/tracks.ts` is a new region on the map, which is how
future tracks (XAML / Avalonia / MAUI …) are added.

Check your work with:

```bash
npm run validate
```

The validator parses every lesson, checks ids, and **runs every challenge's
`solution` against its `tests`** (JS/TS/React in jsdom, SQL in real
PostgreSQL via PGlite). It also checks that the `starter` does NOT already
pass, so a challenge can't be solved by doing nothing.

---

## 1. Frontmatter (required)

```yaml
---
id: fe-05                 # unique; <track-prefix>-<NN>
title: Components & JSX
level: beginner           # beginner | intermediate | advanced | expert
minutes: 20               # realistic time incl. exercises
xp: 100                   # XP for completing the lesson (exercises add their own)
summary: One sentence shown on the map card.
---
```

Track prefixes: `bc` basecamp, `fe` frontend, `be` backend, `db` database,
`ops` containers & kubernetes, `cl` cloud-native toolkit, `pro` pro skills, `cap` capstone.

## 2. Body

Normal GitHub-flavoured Markdown: headings (`##` and below — the title is
rendered from frontmatter, so do not write a `#` heading), lists, tables,
fenced code with a language (`ts`, `tsx`, `js`, `csharp`, `sql`, `bash`,
`json`, `yaml`, `xml`, `dockerfile`, `http`, `text`).

Interactive pieces are **directives**: a line `:::name attr=value …`, a body,
and a line with only `:::`. Attribute values with spaces use quotes:
`title="Hello world"`. Directives may not nest except callouts inside a `lab`.
Inside a fenced code block `:::` is ignored.

Every interactive directive needs an `id` that is unique across the whole
site. Convention: `<lesson-id>-q1`, `<lesson-id>-c1`, `<lesson-id>-sql1`,
`<lesson-id>-lab1`, `<lesson-id>-cards1`.

### Callouts

```md
:::tip
Short helpful markdown.
:::
```

Variants: `tip`, `info`, `warn`, `pro` (what seniors / real teams do),
`job` (what you'll meet on day one at a new job). Optional `title="…"`.

### Quiz

```md
:::quiz id=fe-05-q1 xp=10
What does this log?

```js
console.log(typeof null)
```

- [ ] `"null"`
- [x] `"object"`
- [ ] `"undefined"`
> `typeof null` is `"object"` — a bug from JavaScript's first version, kept for compatibility.
:::
```

* Lines starting `- [ ]` / `- [x]` are options (inline markdown allowed).
  More than one `[x]` makes it multi-select ("select all that apply").
* Lines starting `> ` are the explanation, shown after answering.
* Everything else is the question (markdown, code fences allowed).
* `xp` defaults to 10. Full XP on first try, half after a wrong attempt.

### Code challenge (JS / TS / React — runs in the browser)

```md
:::challenge id=fe-01-c1 lang=ts xp=40
title: Total of a cart
Write `cartTotal(items)` that returns the sum of `price * qty`.

hint: `reduce` with a starting value of 0.
hint: Watch out for the empty array.

```ts starter
export function cartTotal(items: { price: number; qty: number }[]): number {
  // your code
}
```

```ts solution
export function cartTotal(items: { price: number; qty: number }[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0)
}
```

```ts tests
test('empty cart is 0', () => {
  expect(cartTotal([])).toBe(0)
})
test('sums price * qty', () => {
  expect(cartTotal([{ price: 2, qty: 3 }, { price: 1.5, qty: 2 }])).toBe(9)
})
```
:::
```

* `lang` = `js` | `ts` | `jsx` | `tsx`. `jsx`/`tsx` = **React challenge**
  (React 19, runs in an iframe with a DOM).
* Fenced blocks whose info string ends in a role are extracted:
  `starter`, `solution`, `tests` (required) and optional `setup`
  (helper code prepended before the user's code, visible to user + tests).
  Other fences stay in the prompt.
* `hint:` lines become reveal-one-at-a-time hints. `title:` line = title.
* User code and tests run in the **same scope**: tests call the user's
  functions/components by name. `export` is allowed and ignored. Imports
  from `'react'` work (`import { useState } from 'react'`); no other modules.
  Don't declare the same top-level name in tests and code.
* React challenges: add `preview=ComponentName` to render that component
  live in the preview pane after the run (no props).

**Test API** (Jest/Vitest-like, all globals):

* `test(name, fn)` / `it`, `describe(name, fn)`, `beforeEach(fn)`; `fn` may be async.
* `expect(x)` with `.not` and: `toBe`, `toEqual`, `toStrictEqual`,
  `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toBeDefined`,
  `toContain`, `toHaveLength`, `toBeGreaterThan`, `toBeGreaterThanOrEqual`,
  `toBeLessThan`, `toBeLessThanOrEqual`, `toBeCloseTo`, `toMatch`,
  `toThrow(msg?)`, `toBeInstanceOf`, `toHaveProperty`, `toMatchObject`,
  `toHaveBeenCalled`, `toHaveBeenCalledTimes`, `toHaveBeenCalledWith`,
  and `await expect(promise).resolves.toBe(…)` / `.rejects.toThrow(…)`.
* `fn(impl?)` (alias `vi.fn`) – mock function with `.mock.calls`.
* `sleep(ms)` – await real time.
* React only: `render(<C />)` → `{ container, unmount, rerender }`,
  `screen.getByText / queryByText / getAllByText / findByText`,
  `screen.getByRole(role, { name }) / queryByRole / getAllByRole / findByRole`,
  `screen.getByLabelText`, `screen.getByPlaceholderText`, `screen.getByTestId`
  (text/name accept a string = exact trimmed match, or a RegExp);
  `await user.click(el)`, `await user.type(el, 'text')`, `await user.clear(el)`,
  `await user.keyboard('{Enter}')` (keys: `{Enter}` `{Escape}` `{Tab}` `{Shift+Tab}` `{ArrowDown}` `{ArrowUp}` `{ArrowLeft}` `{ArrowRight}` `{Home}` `{End}` or plain characters),
  `await user.tab()` / `user.tab({ shift: true })`, `await waitFor(() => expect(…))`, `act`.
  React hooks (`useState`, `useEffect`, `createContext`, …) are also available as bare globals, so
  helper components written inside `tests` can use them. `localStorage` exists (reset it yourself in tests).
  Not available: `createPortal`, native `<dialog>.showModal()` — use an inline `role="dialog"` element.
  DOM matchers: `toBeInTheDocument`, `toHaveTextContent`, `toHaveValue`,
  `toBeDisabled`, `toBeEnabled`, `toHaveAttribute(name, value?)`,
  `toHaveClass`, `toHaveFocus`, `toBeChecked`.
  `user.*` calls must be awaited. Every test starts with a clean `document.body`.

#### Write-the-tests challenge (`mode=tests`)

The learner writes the tests. Their tests must **pass** against `impl`
and **fail** (at least one test) against every `mutant`.

```md
:::challenge id=fe-20-c1 lang=ts mode=tests xp=60
title: Catch the bugs in `clamp`
Write tests for `clamp(value, min, max)`.

```ts impl
export function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)) }
```
```ts mutant
export function clamp(v: number, min: number, max: number) { return Math.max(min, v) }
```
```ts mutant
export function clamp(v: number, min: number, max: number) { return Math.min(max, v) }
```
```ts starter
test('returns value inside range', () => {
  // expect(...)
})
```
```ts solution
test('inside', () => expect(clamp(5, 0, 10)).toBe(5))
test('below', () => expect(clamp(-1, 0, 10)).toBe(0))
test('above', () => expect(clamp(11, 0, 10)).toBe(10))
```
:::
```

`impl` is shown to the learner (read-only). `tests` is not used in this mode.

### SQL challenge (real PostgreSQL 18 in the browser via PGlite)

```md
:::sql id=db-02-sql1 db=shop xp=30
title: Cheap products
List `name` and `price` of products cheaper than 20, cheapest first.

hint: `WHERE price < 20`

```sql starter
SELECT name, price FROM products
```

```sql solution
SELECT name, price FROM products WHERE price < 20 ORDER BY price, name;
```
:::
```

* `db` = a dataset in `src/content/datasets/<db>.sql` (`shop`, `studio`) or
  `empty`. Optional ```` ```sql setup ```` block runs after the dataset.
* The learner's SQL runs on a fresh database; the LAST statement's result
  is compared with the solution's last result (values, not column names).
  `ordered=true` → row order matters (use it when the task says "order by").
  Otherwise rows are compared as a sorted multiset.
* For DDL/DML tasks add a ```` ```sql check ```` block: a query run after the
  learner's SQL and after the solution; the two check results are compared
  instead.
* Numbers are compared numerically (`20.00` = `20`).

### Lab (hands-on, done locally — C#, tooling, projects)

```md
:::lab id=be-05-lab1 xp=80
title: Your first Minimal API
Steps in markdown, code blocks, nested callouts allowed…

- [ ] `dotnet run` starts and `GET /hello` returns `Hello`
- [ ] The provided xUnit tests pass with `dotnet test`
:::
```

Top-level `- [ ]` lines are the acceptance checklist; the learner ticks them
all to claim XP. Good labs give the **tests to paste in** so the learner can
verify themselves (`dotnet test`, `npm test`).

### Flashcards (quick refresh / interview prep)

```md
:::cards id=be-07-cards1 xp=15 title="DI lifetimes"
Q: What is a Scoped service?
A: One instance per HTTP request (per DI scope).
Q: Singleton?
A: One instance for the app's lifetime.
   Answers may span several lines.
:::
```

XP is given once every card has been flipped.

---

## Writing guidelines

* Explain **why** before **how**. Short paragraphs, real-world examples.
* Every lesson has at least 2 interactive pieces; beginner lessons get more
  quizzes, later lessons get labs / challenges.
* Use modern versions: React 19, Vite 8, TypeScript 5+, .NET 10 / C# 14,
  ASP.NET Core 10, EF Core 10, PostgreSQL 17/18, Playwright, Vitest.
* Add `:::job` callouts with what real teams expect.
* End each lesson with a `## Recap` bullet list.
