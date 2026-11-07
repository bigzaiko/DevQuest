# DevQuest — project status

_Last updated: 2026-11-07._ Live: **https://bigzaiko.github.io/DevQuest/** · Repo: https://github.com/bigzaiko/DevQuest

## State: complete ✅

Nothing open. All regions are written, reviewed, fixed and validated.

| Region | Lessons | Quizzes | Code | SQL | Labs | Time |
|---|---|---|---|---|---|---|
| ⛺ Basecamp | 9 | 64 | 8 | 2 | 9 | ~8h |
| ⚛️ Frontend | 31 | 193 | 123 | 0 | 17 | ~39h |
| 🐘 Database | 21 | 149 | 3 | 194 | 3 | ~28h |
| 🛡️ Backend | 23 | 221 | 14 | 4 | 26 | ~26h |
| 🐳 Containers & Kubernetes | 20 | 157 | 23 | 0 | 30 | ~27h |
| 🧰 Cloud-Native Toolkit | 11 | 96 | 29 | 0 | 12 | ~38h |
| 🧭 Pro Skills | 12 | 95 | 24 | 1 | 12 | ~16h |
| 🐉 Capstone: BranchStory | 11 | 65 | 13 | 9 | 37 | ~53h |
| 🖥️ Desktop & Mobile .NET | 12 | 105 | 28 | 0 | 14 | ~22h |
| **Total** | **150** | **1145** | **265** | **210** | **160** | **~258h** |

## Quality

- Every lesson: writer → independent reviewer (fixes in place) → blind quiz verifier → fixer.
- Every region: coherence critic (progression, gaps, contradictions) → fixer → independent audit.
- `npm run validate` runs every challenge solution against its tests (starter must fail) and every SQL solution on PostgreSQL 18 (PGlite); CI blocks the deploy on failure.
- Many labs were built and run for real: .NET 10 labs (incl. Testcontainers + postgres:18), the whole Capstone app rebuilt from lessons 01–11 (all tests green, container images built), Redis/Postgres labs against real containers.

## Known limitations (by design)

- C#, Docker, Kubernetes, Avalonia/MAUI run in your local labs, not in the browser.
- Labs needing a real cloud account, a kind cluster run-through, or MAUI builds (not possible on Linux) are written carefully but not machine-run end to end.
- PGlite is one connection: locking/isolation is taught with timelines + quizzes.
- Progress lives in your browser — use Progress → Export to back it up.

See `AGENTS.md` for how to add lessons or regions.
