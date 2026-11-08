# Security

DevQuest is a static site with no backend, no accounts and no cookies. Progress lives only in your
browser's `localStorage`.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub → Security → Report a vulnerability](https://github.com/bigzaiko/DevQuest/security/advisories/new),
not in a public issue.

## What protects the site

- **Learner code is isolated.** JS/TS challenges run in a Web Worker. React challenges run in an
  `<iframe sandbox="allow-scripts allow-forms">` with an opaque origin, so they can't read the site's
  storage or DOM. SQL runs in PGlite (PostgreSQL in WASM), entirely in the browser.
- **Content-Security-Policy** (`vite.config.ts`): scripts only from the site itself, no plugins, no
  form posts, no foreign `<base>`.
- **Sanitized lesson HTML**: rendered Markdown goes through DOMPurify (`src/engine/markdown.ts`).
- **Supply chain**: GitHub Actions are pinned to commit SHAs, workflows get least-privilege tokens,
  Dependabot updates dependencies weekly (with a 7-day cooldown), and every PR runs the full test
  suite including the browser self-test.
- **Repository**: secret scanning with push protection, Dependabot security updates, and a ruleset that
  blocks force-pushes to and deletion of `main`.
