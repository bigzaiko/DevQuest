# DevQuest — project status

_Last updated: 2026-11-05._

Live site (after the first push + Pages setup): **https://bigzaiko.github.io/DevQuest/**
Repo: **https://github.com/bigzaiko/DevQuest** (public, `main`)

---

## TL;DR

| Area | State |
|---|---|
| Site (React 19 + Vite 8 + TS) | ✅ done — map, lessons, XP/levels/ranks, streaks, achievements, search (Ctrl/⌘ K), SQL playground, dark/light, phone + tablet layouts |
| In-browser runners | ✅ JS/TS (Web Worker), React (iframe sandbox + live preview), write-the-tests with mutants, SQL on PostgreSQL 18 (PGlite) |
| Skill checks | ✅ 20-question exam per region + 40-question Final Exam; per-level score, estimated level, study list |
| Progress | ✅ saved in `localStorage` (no login/server); Export/Import JSON on the Progress page |
| Content | 🟡 ~107 lessons written, more being written + reviewed (see below) |
| Content validator | ✅ `npm run validate` runs every challenge solution against its tests |
| Deploy | 🟡 workflow ready (`.github/workflows/deploy.yml`); needs first commit/push + Settings → Pages → Source: GitHub Actions |
| Docs | ✅ `README.md`, `AGENTS.md` (+ `CLAUDE.md`), `docs/CONTENT_FORMAT.md`, `docs/DESIGN.md`, this file |

## Content by region (validated 2026-11-05, every challenge solution passes)

| Region | Lessons | Quizzes | Code challenges | SQL challenges | Labs | Time (est.) |
|---|---|---|---|---|---|---|
| ⛺ Basecamp | 8 | 52 | 5 | 1 | 8 | ~6h |
| ⚛️ Frontend | 30 | 179 | 118 | 0 | 16 | ~31h |
| 🐘 Database | 19 | 129 | 0 | 175 | 1 | ~16h |
| 🛡️ Backend | 22 | 208 | 12 | 4 | 25 | ~25h |
| 🐳 Containers & Kubernetes | 19 | 149 | 20 | 0 | 29 | ~25h |
| 🧰 Cloud-Native Toolkit | 10 | 88 | 27 | 0 | 11 | ~37h |
| 🧭 Pro Skills | 12 | 95 | 24 | 1 | 12 | ~15h |
| 🐉 Capstone: BranchStory | 10 | 56 | 12 | 8 | 32 | ~47h |
| **Total** | **130** | **956** | **218** | **189** | **134** | **~200h** |

Quality passes done: every lesson got reviewer → blind quiz verifier → fixer, plus a coherence critic
per region whose contradictions/gaps were fixed and audited. Many .NET labs were built and run on the real
.NET 10 SDK (incl. Testcontainers + Postgres 18).

## Not finished (stopped to save usage — safe to resume later)

- Round 4 (Capstone + Cloud): coherence fixes may be partial; Capstone lab code for lessons 08–10 was
  **not** build-verified; new lesson "v2 Without Downtime" (cap-11) not written.
- Round 5 (Database): new lesson "Postgres From Your Code" not written; db coherence fixes (GIN dedupe,
  replicas/CDC, on-call section, pg_trgm/pgvector) may be partial.
- Time estimates (`minutes`) are still low in some lessons.
- Desktop & Mobile .NET region (XAML / Avalonia / MAUI) — coming soon.

## Next steps

1. Push to `main` (GitHub Desktop: Add local repository → this folder → Push origin).
2. GitHub → **Settings → Pages → Source: GitHub Actions**; wait for the green Actions run.
3. Open https://bigzaiko.github.io/DevQuest/
4. Later: finish the items above (see `AGENTS.md` for how to add/review lessons).

## Known limitations

- **C# can't run in the browser**: backend lessons use quizzes, flashcards and local labs with xUnit tests to paste in.
- **PGlite is one connection / one implicit transaction per run**: locking, isolation anomalies,
  `CREATE INDEX CONCURRENTLY`, `VACUUM` in a batch etc. are taught with timelines + quizzes, not live.
  Only the `plpgsql` extension is available; `pg_stat_*` counters don't update.
- **TypeScript types are stripped, not checked** in challenges — tests check runtime behaviour.
- **React challenges**: only `react` can be imported; no `createPortal` / `<dialog>.showModal()`.
- **Labs aren't machine-verified** (Docker/K8s/.NET run on your machine) — commands were reviewed, not executed.
  Version-sensitive bits (GitHub Actions major versions, Helm chart value keys, KEDA trigger params) carry a "check the docs" note.
- **Progress is per browser**: clearing site data deletes it — use Export/Import to back up or move devices.

## Where things live

| What | Where |
|---|---|
| Lessons | `src/content/<region>/NN-slug.md` |
| Regions / map / route | `src/content/tracks.ts` |
| SQL datasets | `src/content/datasets/{shop,studio}.sql` |
| Lesson format | `docs/CONTENT_FORMAT.md` |
| Design rules | `docs/DESIGN.md` |
| Contributor/agent guide | `AGENTS.md` |
| Deploy pipeline | `.github/workflows/deploy.yml` |
