# Security

DevQuest is a static site with no backend, no accounts and no cookies. Progress lives only in your
browser's `localStorage`.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub → Security → Report a vulnerability](https://github.com/bigzaiko/DevQuest/security/advisories/new),
not in a public issue.

## What protects the site

- **Learner code runs apart from the page.** JS/TS challenges run in a Web Worker, React challenges
  in a separate iframe (fresh per run, driven only by its parent via `postMessage`), SQL in PGlite
  (PostgreSQL in WASM). It is only ever the learner's own code. The iframe is *not* given an opaque
  origin: Chrome then blocks `focus()` inside it, which breaks the focus-management challenges.
- **Content-Security-Policy** (`vite.config.ts`): scripts only from the site itself, no plugins, no
  form posts, no foreign `<base>`.
- **Sanitized lesson HTML**: rendered Markdown goes through DOMPurify (`src/engine/markdown.ts`).
- **Supply chain**: GitHub Actions are pinned to commit SHAs, workflows get least-privilege tokens,
  Dependabot updates dependencies weekly (with a 7-day cooldown), and every PR runs the full test
  suite including the browser self-test.
- **Repository**: secret scanning with push protection, Dependabot security updates, and a ruleset that
  blocks force-pushes to and deletion of `main`.
