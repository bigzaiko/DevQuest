<div align="center">

# 🎮 DevQuest

**A gamified full-stack academy — from first component to production architect.**

React 19 · Vite · TypeScript · C# / ASP.NET Core 10 · PostgreSQL 18 · Docker · Kubernetes

**▶ Play it: https://bigzaiko.github.io/DevQuest/**

</div>

---

DevQuest is a self-paced training ground for full-stack developers: preparing for a new job,
or refreshing what you already know. Every topic is explained properly (the *why*, not just the
*how*) and then practised with exercises that are actually checked:

| | What you do | How it's checked |
|---|---|---|
| ❓ **Quizzes** | "What does this print?", "spot the bug", "which design is right" | instantly, with explanations |
| ⌨️ **Code challenges** | write JS / TS / **React** components | real tests in a browser sandbox, live preview |
| 🧪 **Write-the-tests** | *you* write the tests | they must pass on the real code and catch hidden buggy "mutants" |
| 🐘 **SQL challenges** | query and modify data | on **real PostgreSQL 18** running in your browser (PGlite / WASM) |
| 🔬 **Labs** | build C# APIs, Dockerfiles, K8s clusters on your machine | step-by-step, with tests to paste in and a checklist |
| 🃏 **Flashcards** | quick refresh / interview prep | flip through every card |
| 🎓 **Skill checks** | a 20-question exam per region, 40 for the final | score per level and an estimated level, with links to what to study |

### The map

| Region | Topics |
|---|---|
| ⛺ **Basecamp** | dev setup, terminal, Git, GitHub flow, publishing this site, your first weeks at a new job |
| ⚛️ **Frontend** | modern JS, TypeScript, Vite, React 19 (state, effects, forms, hooks), routing, TanStack Query, design tokens, **UI component forge**, accessible dialogs, **modular feature architecture**, performance, Vitest + Testing Library, Playwright + axe, real-time UI with 409 conflict handling, auth & security |
| 🐘 **Database** | SELECT → JOINs → GROUP BY, DDL & constraints, modeling, CTEs (recursive!), window functions, indexes & EXPLAIN, transactions & locking, jsonb, triggers, **job queues with SKIP LOCKED**, production Postgres, tuning |
| 🛡️ **Backend** | C# 14 & .NET 10, LINQ, async, Minimal APIs, validation & ProblemDetails, DI, middleware, **EF Core + Npgsql**, architecture, auth (JWT/OIDC), xUnit + **Testcontainers**, background jobs, **SignalR**, optimistic concurrency & idempotency, observability, performance |
| 🐳 **Containers & Kubernetes** | containers explained, Docker CLI, Dockerfiles, multi-stage builds for .NET & Vite, Compose, networking & volumes, image security, registries & CI → K8s concepts, Deployments, Services/Ingress, config & probes, storage & operators, Helm/Kustomize, HPA/KEDA scaling, production ops |
| 🧰 **Cloud-Native Toolkit** | Redis (data types, caching, reliable queues, streams, locks), message brokers & the outbox pattern, S3 presigned uploads, KEDA autoscaling, Keycloak identity, OpenTelemetry + Prometheus + Grafana + Loki |
| 🧭 **Pro Skills** | CI/CD, config & secrets, OWASP security, debugging, teamwork & code review, clean code & patterns, system design, interview prep |
| 🐉 **Capstone: BranchStory** | build a production-shaped full-stack app end to end: React editor, ASP.NET API, Postgres, real-time co-editing, job worker, tests, CI, Kubernetes |
| 🖥️ **Desktop & Mobile .NET** | XAML & C# primer, the .NET UI landscape, Avalonia (layout, MVVM with CommunityToolkit, styles/themes, DI & navigation, async & validation), .NET MAUI (Shell, platform features, offline sync), testing & packaging, and a boss: a BranchStory desktop + mobile client |
| 🎞️ **Video Playback on the Web** | frames, codecs & keyframes, HLS playlists and Media Source Extensions, frame-accurate jumps along a path (requestVideoFrameCallback, WebCodecs), seamless loops by appending laps, clean audio seams (AAC frames, priming, equal-power cross-fades) |

Every region starts with a beginner **syntax primer** (JS/TS, SQL, C#, shell/YAML/Docker, XAML, cloud big picture) and Basecamp explains how challenges, tests and error messages work — including German/English keyboard tips (the editor turns `´ ’ “ ” „` into real quotes automatically).

Everything is unlocked: follow the suggested route, or jump straight to whatever you want to refresh.

### Game mechanics

XP for every exercise (full XP on the first try, half after a miss, a quarter after peeking at the
solution) · levels and ranks (Intern → Junior → … → Architect → Legend) · daily streaks ·
achievements · skill-check exams · a search palette (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>) ·
an SQL playground · dark and light themes · works on phones and tablets.

**Your progress is saved in your browser** (`localStorage`). There's no account, no server, and
nothing to pay. Use **Progress → Export** to back it up or move it to another device.

---

## Run it locally

Requires **Node 22+** (CI uses Node 24).

```bash
git clone https://github.com/bigzaiko/DevQuest.git
cd DevQuest
npm install
npm run dev          # → http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm run validate` | parses every lesson and **runs every challenge's solution against its tests** (JS/React in jsdom, SQL in PGlite) |
| `npm run typecheck` | TypeScript check |
| `npm run build` | production build → `dist/` |
| `npm run preview` | serve `dist/` like GitHub Pages would |
| `npm run selftest` | after a build: every lesson and challenge in headless Chromium (`CHROMIUM_PATH=/usr/bin/chromium`) |

**VS Code:** press **F5** ("DevQuest: dev (Chrome)") to start the dev server and open Chrome with the
debugger attached; stopping the debugger stops the server. The second launch config runs the
production build via `preview`. **Ctrl+Shift+B** starts the dev server. *Tasks: Run Task* also has
`build`, `typecheck`, `validate`, `selftest` and `check all (like CI)`.

**Private regions:** folders `src/content/private-<name>/` (with a `_track.json`) are gitignored and
local only. `npm run dev` shows them; builds leave them out unless `DEVQUEST_PRIVATE=1`, and the build
fails if private content would end up in `dist/`.

## Deploy to GitHub Pages

The workflow `.github/workflows/deploy.yml` validates, builds and deploys on every push to `main`.

1. The repository must be **public** (free GitHub Pages requires it; the site contains no secrets).
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main` (from GitHub Desktop: *Commit* → *Push origin*, or `git push`).
4. Watch the **Actions** tab; when it's green the site is live at `https://<user>.github.io/DevQuest/`.

The in-app lesson **Basecamp → "Publish DevQuest on GitHub Pages"** walks through this step by step
and explains how it works (`base: './'`, hash routing, `npm ci`, CI as a quality gate).

## Add your own lessons

A lesson is one Markdown file with directives:

```md
:::quiz id=fe-05-q1
What does `typeof null` return?
- [ ] "null"
- [x] "object"
> A historical bug kept for compatibility.
:::
```

- **Format reference:** [`docs/CONTENT_FORMAT.md`](docs/CONTENT_FORMAT.md)
- **Project guide for contributors and AI agents:** [`AGENTS.md`](AGENTS.md)
- **Design system:** [`docs/DESIGN.md`](docs/DESIGN.md)

New region: create `src/content/<folder>/`, add it to `src/content/tracks.ts`, run `npm run validate`.

## Tech

React 19 · Vite 8 · TypeScript · CodeMirror 6 · Sucrase (in-browser TS/JSX compile) ·
PGlite (PostgreSQL 18 in WASM) · marked + highlight.js · no backend.

## License

Content and code © bigzaiko. Add a license file (e.g. MIT for the code, CC BY-SA for the content) if you want others to reuse it.
