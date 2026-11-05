# DevQuest design system — "Arcade Night"

The single source of truth for colours, type and components is `src/styles.css` (tokens at the
top). This file explains the rules so new pages and regions stay consistent.

## Identity

A gamified training ground that still reads like serious documentation. **The game layer frames
the learning; it never gets in the way of reading code.**

- Deep indigo "night sky" background with a faint starfield and nebula glows.
- Neon accents with fixed meanings (below).
- Chunky, tactile "game buttons" (3 px bottom border that compresses on press).
- A pixel display face (**Pixelify Sans**) for *game* text only — headings h1, level numbers,
  XP, scores, region names, eyebrows. Body text is **Inter**; code is **JetBrains Mono** / system mono.

## Colour tokens & meaning

| Token | Value (dark) | Meaning — use only for this |
|---|---|---|
| `--flare` / `--gold` | `#ffc83d` | XP, primary actions, progress, "next" |
| `--beam` | `#3de8ff` | knowledge, links, code challenges |
| `--magenta` | `#ff4fd8` | rare things: bosses, exams, eyebrows, level-up |
| `--ok` | `#7cff6b` | solved / correct / done |
| `--bad` | `#ff4f6d` | wrong answers, failing tests, errors |
| `--warn` | `#ffb020` | warnings, hints |
| `--info` | `#6f9bff` | SQL, "good to know" |
| `--pro` | `#c07bff` | labs, "pro move" callouts |
| `--grad-xp` | gold → orange → magenta → cyan | XP bars, big scores, the brand word |
| `--track` | per region (see `tracks.ts`) | set on a region's pages; tints icons, path, progress |

Surfaces step up in lightness: `--bg` → `--bg-2` → `--surface` → `--surface-2` → `--surface-3`.
Text: `--text` (primary), `--text-2` (secondary), `--muted` (meta). Borders: `--border`, `--border-strong`.
Both themes (dark default, `data-theme="light"`) must work — never hard-code a colour in a
component when a token exists. The only hard-coded colours allowed are inside code blocks/editor
(always dark) and the React preview sandbox (always light, like a real browser page).

## Type scale

- `h1` lesson/page title: pixel face, `clamp(1.9rem, 3.4vw, 2.6rem)`; hero up to 3.6rem.
- `h2` section 1.45rem, `h3` 1.15rem — Inter, tight letter-spacing.
- Body 15.5 px / 1.65. Meta text `.ex-note` ~0.8rem `--muted`.
- Chips/eyebrows: uppercase, 0.72–0.85rem, letter-spaced.

## Components (class names)

| Component | Classes | Notes |
|---|---|---|
| Buttons | `.btn`, `.btn-primary`, `.btn-beam`, `.btn-ghost`, `.btn-danger`, `.btn-sm` | one primary button per area |
| Chips | `.chip`, `.chip-xp`, `.chip-ok`, `.chip-level-<level>` | |
| Level badge | `.level-badge` (hexagon gem), size via `--s` | |
| XP bar | `.xpbar > i` (segmented gradient) | width = progress % |
| Region card | `.realm` (+ `.recommended`, `.soon`) | set `--track` |
| Lesson path | `.path` + `.node` (+ `.done`, `.current`, `.boss`, `.plain`) | number via `data-n` |
| Exercise card | `.ex.ex-<kind>` → `.ex-head` / `.ex-body`, `.solved` | kinds: quiz, challenge, sql, lab, cards |
| Callouts | `.callout.callout-<tip|info|warn|pro|job>` | |
| Results | `.results`, `.results-head.pass/.fail`, `.test-row` | |
| Toast / modal | `.toast`, `.modal-back` + `.modal` | |
| Exams | `.exam-grid`, `.exam-card`, `.exam-score`, `.level-bars` | |

## Motion

Use `--ease` and `--dur-*`. Motion is feedback (XP toast, level-up, wrong-answer shake, current
node pulse) — not decoration. Everything collapses under `prefers-reduced-motion`.

## Layout & responsive

- Content column max `--content-w` (820 px); pages max 1180 px.
- ≤ 1100 px: compact header (icon search, no XP text).
- ≤ 1000 px: lesson sidebar hidden, hero stacks.
- ≤ 760 px (phones): top nav hidden → **bottom tab bar** (`.mobile-nav`); single-column grids.
- Touch devices (`pointer: coarse`) hide keyboard-shortcut hints (`.kbd-hint`).
- No horizontal page scroll at 375 px — code blocks/editors/tables scroll inside themselves.

## Accessibility (target WCAG 2.2 AA)

Visible focus ring (`:focus-visible` gold outline), real `<button>`s for actions, `aria-pressed`
on quiz options, `aria-live` on results/toasts, dialogs with `role="dialog"` + `aria-modal` + Escape,
skip link, colour is never the only signal (✓/✖ icons + text).

## Adding a region

Pick a distinct `color` in `src/content/tracks.ts`, an emoji `icon`, a `realm` name
(fantasy place, e.g. "XAML Isles"), and a one-sentence `tagline`. Everything else is derived.
