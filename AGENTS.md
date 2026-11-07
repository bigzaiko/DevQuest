# AGENTS.md — working on DevQuest

Instructions for humans and AI agents extending this project. Read this first, then
`docs/CONTENT_FORMAT.md` (lesson format) and `docs/DESIGN.md` (visual rules).

## What this is

DevQuest is a gamified full-stack training site (React 19 + Vite 8 + TypeScript), deployed as a
static site to GitHub Pages: https://bigzaiko.github.io/DevQuest/. Lessons are Markdown files with
interactive directives (quiz, code challenge, SQL challenge, lab, flashcards). Code challenges run
in the browser against real tests; SQL challenges run on PostgreSQL 18 compiled to WASM (PGlite).
Progress (XP, levels, achievements, exam results, code drafts) is stored in `localStorage` — there
is **no backend and no login**, by design.

## Commands

```bash
npm install
npm run dev        # http://localhost:5173
npm run validate   # every region in its own process: parse lessons + run every challenge solution against its tests (REQUIRED before commit)
npm run validate:one -- frontend/0 ops/   # only matching paths
npm run typecheck
npm run build      # → dist/
npm run preview
```

CI (`.github/workflows/deploy.yml`) runs validate → typecheck → build → deploy on push to `main`.
A failing validation blocks the deploy.

## Layout

```
src/
  content/
    tracks.ts            ← the map: regions, colours, order (ROUTE)
    index.ts             ← loads lesson summaries (eager) + full lessons (lazy)
    datasets/*.sql       ← SQL datasets: shop, studio (deterministic data, no now()/random())
    <track>/NN-slug.md   ← lessons, ordered by filename
  engine/
    parse.ts             ← Markdown + directive parser (shared with the validator; erasable TS only)
    progress.ts          ← XP/levels/ranks/streak/exams store (localStorage)
    achievements.ts      ← achievement rules
    markdown.ts          ← marked + highlight.js
  runners/
    harness.ts           ← Jest-like test/expect
    dom.ts               ← React Testing Library–like helpers
    execute.ts           ← compile (sucrase) + run a challenge (code / write-the-tests modes)
    jsWorker.ts          ← runs non-React challenges in a Web Worker (killable)
    sandbox.ts           ← React challenges in an iframe (sandbox.html) + live preview
    sql.ts / client.ts   ← SQL grading; one shared PGlite instance reset per run
  components/            ← TopBar, Toasts, CommandPalette, CodeEditor (lazy), blocks/*
  pages/                 ← Home, TrackPage, LessonPage, Exam, Profile ("Progress"), Playground
scripts/validate-content.ts  ← the content validator (Node 22+ type stripping + jsdom + PGlite)
vite.config.ts           ← `?meta` plugin that turns a lesson into a small JSON summary
```

## Adding content

1. **A lesson:** add `src/content/<track>/NN-slug.md` following `docs/CONTENT_FORMAT.md`.
   Lesson id `<prefix>-NN`, exercise ids `<lesson-id>-q1` / `-c1` / `-sql1` / `-lab1` / `-cards1`.
   Never reuse or rename an existing id — saved progress is keyed by id.
2. **A region:** create the folder, add its entry in `src/content/tracks.ts` (`soon: true` shows it
   as "coming soon"), add the prefix to `PREFIX` in `scripts/validate-content.ts`, and add it to `ROUTE` if it belongs
   in the recommended path. Achievements and the skill check for the region appear automatically.
3. **A SQL dataset:** add `src/content/datasets/<name>.sql`; reference it with `db=<name>`.
4. Run `npm run validate` until it reports 0 errors.

### Content quality bar

- Explain *why* before *how*; real-world examples; `:::job` (what work expects) and `:::pro`
  (what seniors do) callouts; end with `## Recap`. No `#` h1 in lessons.
- ≥ 4 interactive pieces per lesson; quizzes need a `>` explanation (exams reuse quizzes and show
  the explanation in the review).
- Challenge tests must fail on the starter and pass on the solution (the validator enforces it).
- SQL: deterministic results; `ordered=true` only with a total ORDER BY.
- Versions: React 19, Vite 8, TS 5+, .NET 10 / C# 14, EF Core 10, PostgreSQL 18, current Docker/K8s APIs.
- Labs give exact commands, full files, expected output, and tests to verify.

## Code conventions

- TypeScript strict; function components; no class components except error boundaries.
- `src/engine/parse.ts` and `src/runners/{harness,dom,execute,sql}.ts` are imported by Node
  (the validator) — keep them free of Vite-only APIs and non-erasable TS (enums, parameter properties).
- Colours/spacing via CSS tokens only (see `docs/DESIGN.md`). New UI must work at 375 px wide.
- Progress schema changes: add fields with defaults in `empty()` in `progress.ts`; never break old
  saved data or exported JSON files.
- Hash routing only (`#/…`) — GitHub Pages has no server-side routing.

## Runner capabilities & limits (for challenge authors)

- Only `react` can be imported. React hooks are also bare globals inside tests.
- jsdom-like DOM in the validator, a real DOM in the browser — write tests that pass in both.
- No `createPortal`, no `<dialog>.showModal()`; use inline `role="dialog"`.
- Tab / Shift+Tab move focus over focusable elements (excluding `tabindex="-1"`).
- PGlite is a single connection: concurrency/locking is taught with quizzes, not live demos.
- Each run gets a fresh DB; each test gets a clean `document.body`. Module-level variables in
  user code persist across tests within one run — reset them in tests if needed.
