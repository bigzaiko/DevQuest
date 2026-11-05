---
id: bc-01
title: Welcome to DevQuest
level: beginner
minutes: 20
xp: 50
summary: How the academy works — XP, quizzes, code challenges, SQL on real Postgres, labs and flashcards.
---

DevQuest is a training ground for **full-stack developers**: React + Vite + TypeScript on the
frontend, C# / ASP.NET Core on the backend, PostgreSQL for data, and Docker + Kubernetes to ship it.
It starts at "what is a component?" and ends at the kind of architecture you find in a real SaaS
product — optimistic concurrency, job queues, real-time collaboration, CI/CD and clusters.

Whether you're preparing for a new full-stack job or refreshing skills you haven't used in a while,
the goal is the same: you should leave each lesson able to **do** the thing, not just recognise it.

## Why it's built like a game

Reading about code feels productive, but most of it is forgotten within days. Two things make
knowledge stick, and every lesson is built around them:

- **Retrieval practice** — pulling an answer *out* of your head (a quiz, a flashcard) strengthens
  memory far more than reading the same text again. Getting it wrong first, then reading why, works
  even better than getting it right by luck.
- **Doing it for real** — writing code until tests pass, or running a command on your own machine,
  forces you to resolve all the small details a text can skip over.

The XP, levels and ranks are just there to make that habit pleasant. They don't measure seniority —
your ability to explain and apply the material does.

## How a lesson works

Each lesson mixes reading with interactive pieces. Every piece gives **XP** (experience points). XP
raises your **level**, and levels unlock **ranks**: Intern → Junior Developer → Developer →
Senior Developer → Tech Lead → Staff Engineer → Principal Engineer → Architect → Legend.

| Piece | What you do | Where it runs |
|---|---|---|
| **Quiz** | Pick the right answer(s). Some quizzes are "select all that apply". | Browser |
| **Code challenge** | Write JS/TS/React until the tests go green. | Browser (sandbox) |
| **SQL challenge** | Query a real PostgreSQL database. | Browser (PGlite = Postgres in WASM) |
| **Lab** | Build something on your machine, tick the checklist. | Your computer |
| **Flashcards** | Flip through key facts — perfect for refreshing. | Browser |

How much XP you get for an exercise:

| Situation | XP |
|---|---|
| Correct on the first try (quiz answer, or first test run) | 100 % |
| Correct after at least one wrong answer or failing run | 50 % |
| Solved after opening the solution (**Give up?** / **Solution** button) | 25 % |

Each exercise pays out only once. The **Complete lesson** button at the bottom unlocks once every
exercise in the lesson is solved (labs: tick all items, then **Claim lab XP**; flashcards: flip every
card), and it pays the lesson's bonus XP. "I know this already — mark done" skips ahead but gives no
bonus.

:::tip title="Your progress lives in your browser"
Progress is saved in your browser's `localStorage` — there is no account and no server. That means
clearing site data, using a private window, or switching browser/computer starts you from zero. Use
**Progress → Export progress** to download a backup file and **Import progress** to restore it.
:::

:::tip title="Keyboard shortcuts"
`Ctrl/⌘ + Enter` runs the tests in a code or SQL challenge. `Ctrl/⌘ + K` opens the command palette
to jump to any lesson or page.
:::

## Try each piece once

### A quiz

Pick an answer; if it's wrong, try again (for half XP). Once you get it right the explanation
appears — **always read it**, even if you got it right on the first try. The explanation is where the actual teaching happens: it tells you why the wrong options are
wrong, which is exactly what interviewers probe.

:::quiz id=bc-01-q1 xp=10
What gives you **full** XP on a quiz?
- [ ] Answering fast
- [x] Answering correctly on the first try
- [ ] Reading the explanation first
> Only correctness on the first attempt counts — there is no timer, so speed doesn't matter. The
> explanation only appears once you've answered correctly, so you can't read it first. A wrong first attempt still
> lets you retry, but for half the XP.
:::

### A code challenge

A challenge gives you a **starter** (code that doesn't work yet) and a set of **tests** you don't
see in full. You edit the code and press **Run tests**; each test shows up by name as green (pass)
or red (fail) with the reason. This is exactly the loop you'll use at work with Vitest or xUnit: make a change,
run the tests, read the failure, repeat.

:::challenge id=bc-01-c1 lang=ts xp=20
title: Your first green test
Make `greet(name)` return `"Hello, <name>!"` — for example `greet('Ada')` returns `"Hello, Ada!"`
(capital H, a comma and a space after "Hello", an exclamation mark at the end). Press **Run tests**
(or `Ctrl/⌘ + Enter`).

hint: Template literals use backticks and `${…}` to insert a value: `` `Hello, ${name}!` ``
hint: Tests compare strings exactly — check the comma, the space and the `!`.

```ts starter
export function greet(name: string): string {
  return ''
}
```

```ts solution
export function greet(name: string): string {
  return `Hello, ${name}!`
}
```

```ts tests
test('greets Ada', () => {
  expect(greet('Ada')).toBe('Hello, Ada!')
})
test('greets anyone', () => {
  expect(greet('World')).toBe('Hello, World!')
})
```
:::

### A React challenge

React challenges run your component in a real DOM. A component is a function that returns what
should be on screen; **state** (`useState`) is a value React remembers between renders. Calling the
setter (`setLikes`) stores a new value and makes React re-render the component with it — you never
change the DOM by hand.

:::challenge id=bc-01-c2 lang=tsx xp=20 preview=LikeButton
title: A tiny React component
Make `LikeButton` render a single `<button>` whose text is `Likes: 0` at first and that counts up by
one on every click (`Likes: 1`, `Likes: 2`, …). The preview pane renders your component after the run.

hint: Create state inside the component: `const [likes, setLikes] = useState(0)`
hint: Attach a handler: `onClick={() => setLikes(n => n + 1)}` and render `Likes: {likes}`.

```tsx starter
import { useState } from 'react'

export function LikeButton() {
  return <button>Likes: ?</button>
}
```

```tsx solution
import { useState } from 'react'

export function LikeButton() {
  const [likes, setLikes] = useState(0)
  return <button onClick={() => setLikes((n) => n + 1)}>Likes: {likes}</button>
}
```

```tsx tests
test('starts at zero', () => {
  render(<LikeButton />)
  expect(screen.getByRole('button')).toHaveTextContent('Likes: 0')
})
test('counts clicks', async () => {
  render(<LikeButton />)
  const btn = screen.getByRole('button')
  await user.click(btn)
  await user.click(btn)
  expect(btn).toHaveTextContent('Likes: 2')
})
```
:::

:::info title="Why setLikes(n => n + 1)?"
`setLikes(likes + 1)` also passes here, but it uses the value `likes` had when *this render*
happened. If you call it twice in one click, both calls see the same old value and you only go up by
one. The **updater function** form `n => n + 1` always receives the latest value. You'll meet this
again in the Frontend region.
:::

### A "write the tests" challenge

Here it's reversed: the code is given and **you write the tests**. Behind the scenes we run your
tests against the correct code (they must pass) and against deliberately broken copies called
**mutants** (at least one of your tests must fail on each). This is called *mutation testing*, and it
answers a question coverage numbers can't: "would my tests actually notice a bug?"

:::challenge id=bc-01-c3 lang=ts mode=tests xp=25
title: Be the tester
Write tests for `isAdult(age)` (shown below — adult means 18 or older). Your tests must **pass** on
this correct version and **fail** on each of two hidden buggy versions. Write at least one test with
`test('name', () => { expect(...).toBe(...) })`.

hint: Bugs love boundaries. What should `isAdult(18)` return?
hint: A version that always says `true` passes every "is an adult" test. Which test would it fail?

```ts impl
export function isAdult(age: number): boolean {
  return age >= 18
}
```

```ts mutant
export function isAdult(age: number): boolean {
  return age > 18
}
```

```ts mutant
export function isAdult(age: number): boolean {
  return true
}
```

```ts starter
test('a 30 year old is an adult', () => {
  expect(isAdult(30)).toBe(true)
})
```

```ts solution
test('adult', () => expect(isAdult(30)).toBe(true))
test('exactly 18 counts', () => expect(isAdult(18)).toBe(true))
test('child', () => expect(isAdult(12)).toBe(false))
```
:::

:::quiz id=bc-01-q2 xp=10
Suppose a buggy version of `isAdult` uses `return age > 18` instead of `>=`. Which single test
catches it (passes on the correct code, fails on the mutant)?
- [ ] `expect(isAdult(30)).toBe(true)`
- [x] `expect(isAdult(18)).toBe(true)`
- [ ] `expect(isAdult(12)).toBe(false)`
- [ ] `expect(isAdult(17)).toBe(false)`
> `>=` and `>` only disagree at exactly 18: the correct code says `true`, the mutant says `false`.
> For 30, 12 and 17 both versions return the same result, so those tests pass on the mutant and
> don't catch it. This is why good tests target **boundaries** — off-by-one bugs live there.
:::

### A SQL challenge

SQL challenges run on **PGlite**, which is real PostgreSQL compiled to WebAssembly and running in
your browser tab. Every run starts from a fresh copy of the dataset, so you can't break anything.
Your result is compared with the expected result by **values** (column names don't matter), and row
order only matters when the task says so.

:::sql id=bc-01-sql1 db=shop xp=15
title: Hello, PostgreSQL
This is a real Postgres database with an online shop. Return every customer's `name` and `country`
(two columns, one row per customer) — the starter is almost there.

hint: List several columns by separating them with commas: `SELECT a, b FROM …`

```sql starter
SELECT name FROM customers;
```

```sql solution
SELECT name, country FROM customers;
```
:::

:::quiz id=bc-01-q3 xp=10
You cleared your browser's site data for DevQuest. What happened to your XP?
- [ ] Nothing — it's stored in your DevQuest account on the server
- [x] It's gone, unless you exported a backup from the Progress page and import it again
- [ ] It's restored automatically the next time you log in
- [ ] Only your lab checklists are lost; quiz XP is kept
> DevQuest has no accounts and no server-side storage: everything lives in `localStorage` in your
> browser. Clearing site data wipes it all, not just part of it. **Export progress** gives you a
> file you can import again — on the same or another computer.
:::

### Labs and flashcards

**Labs** are for things a browser can't do: installing an SDK, running `dotnet`, starting Docker
containers. Each lab has exact steps and a checklist; you tick the items yourself, so be honest —
the point is that it works on *your* machine.

**Flashcards** sit near the end of most lessons. Read the question, answer it in your head (or out
loud — that's interview practice), then flip. Revisit decks a few days later; spaced repetition is
what turns "I read that once" into "I know that".

:::quiz id=bc-01-q4 xp=10
Which pieces run **on your own computer** rather than in the browser?
- [ ] SQL challenges — they need a PostgreSQL server installed locally
- [ ] React code challenges — they need `npm run dev`
- [x] Labs — you build and run things locally, then tick the checklist
- [ ] Flashcards — they're printed out
> Labs are the only piece that runs on your machine (SDKs, Docker, editors). SQL challenges are
> tempting, but they use PGlite — PostgreSQL compiled to WebAssembly inside the browser — so you
> need nothing installed. Code and React challenges also run in an in-browser sandbox.
:::

:::job title="Practice like you'll work"
At a real job, nobody hands you multiple-choice questions — you get a ticket, an unfamiliar repo and
a failing test. Use the labs to build the muscle memory for *your* setup (terminal, editor,
debugger), and keep a notes file of every command and error you meet. That file becomes your
personal runbook in week one.
:::

:::pro title="How seniors learn a new stack"
Experienced developers don't try to memorise everything. They learn the **mental model** (what is
the framework doing for me?), know where the docs are, and build a tiny throwaway project to test an
idea before touching the real codebase. Do the same here: when a lesson explains something
surprising, open a scratch project and try it.
:::

:::lab id=bc-01-lab1 xp=20
title: Set your goal
Decide what you're here for and write it down (a sticky note counts!). Suggested routes:

- **New job, full-stack:** Basecamp → Frontend → Database → Backend → Containers & Kubernetes →
  Cloud-Native Toolkit (Redis, caching, queues, S3 uploads, KEDA, Keycloak, observability) →
  Pro Skills (CI/CD, debugging, secrets, security, teamwork) → Capstone.
- **Refreshing:** jump into any region; use the flashcards at the end of lessons to find gaps fast.
  Two regions are easy to skip but pay off at almost every job: **Cloud-Native Toolkit** (the
  Redis, queue and identity pieces most products run next to their database) and **Pro Skills**
  (how teams build, debug and ship).
- **Interview prep:** the Pro Skills region (system design, interview prep, clean code) + every
  flashcard deck.

Then put a recurring slot in your calendar. Short daily sessions beat one long weekend session,
because spaced practice is what makes things stick.

- [ ] I picked a route
- [ ] I blocked time in my calendar (even 30 minutes a day works)
:::

:::cards id=bc-01-cards1 xp=10 title="DevQuest basics"
Q: Where is your progress stored?
A: In your browser's localStorage — no account, no server. Export it from the Progress page to back it up.
Q: What runs SQL challenges?
A: PGlite — PostgreSQL compiled to WebAssembly, running in your browser.
Q: How do labs work?
A: You build it on your machine, then tick every checklist item.
Q: How much XP after a wrong first attempt? After opening the solution?
A: Half (50 %) after a miss; a quarter (25 %) after opening the solution.
Q: What is a mutant in a "write the tests" challenge?
A: A deliberately broken copy of the code. Good tests fail on every mutant while passing on the real code.
:::

## Recap

- XP comes from quizzes, challenges, SQL, labs, cards and finishing lessons; first-try answers get full XP.
- Code and SQL run right in your browser (SQL on real PostgreSQL via PGlite); labs run on your machine.
- Always read quiz explanations — they explain why the wrong answers are wrong.
- Progress lives in `localStorage`: export it to back it up.
- Solve every exercise, then click **Complete lesson** to collect its bonus XP.
