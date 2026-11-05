---
id: fe-23
title: End-to-End Testing with Playwright
level: advanced
minutes: 45
xp: 190
summary: Real browsers, real user flows — locators, auto-waiting, fixtures, auth reuse, network mocking, traces, CI and an axe accessibility gate.
---

Unit and component tests (Vitest + Testing Library) prove that *pieces* work. They run in jsdom — a fake
DOM with no layout, no real network, no CSS, no browser quirks. **End-to-end (e2e) tests** prove that the
*assembled product* works: a real Chromium/Firefox/WebKit loads your built app, clicks through it like a
user, talks to a real (or mocked) API, and asserts on what a person would see.

They are slower and more expensive, so you write **fewer** of them and you aim them at the flows that
would cost money if they broke: sign-in, checkout, "create a project", "invite a teammate".

```text
            ▲  few      e2e (Playwright)        — critical user journeys, real browser
           ▲▲▲          integration/component   — RTL + MSW, one feature at a time
         ▲▲▲▲▲▲▲  many  unit                     — pure functions, reducers, hooks
```

**Playwright** (by Microsoft) is today's default e2e tool for web apps. Why it won over Selenium and
(for most teams) Cypress:

- **One API, three engines** — Chromium, Firefox and WebKit (Safari's engine), headless or headed.
- **Auto-waiting** — actions wait for elements to be visible, stable, enabled and receiving events. No `sleep(2000)`.
- **Web-first assertions** — `await expect(locator).toHaveText('Saved')` *retries* until true or timeout.
- **Isolation** — each test gets a fresh **browser context** (like a new incognito profile) in milliseconds.
- **Tooling** — codegen, UI mode, and the **trace viewer** (a time-travel recording of a failed CI run).
- Runs tests **in parallel** across workers out of the box.

## Install and configure

```bash
npm init playwright@latest        # asks a few questions, creates config + example test
# or, in an existing Vite project:
npm i -D @playwright/test
npx playwright install --with-deps chromium   # downloads the browser binaries (+ OS libs on Linux)
```

A production-grade `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,          // a stray test.only fails CI instead of silently skipping everything
  retries: process.env.CI ? 2 : 0,       // retries in CI only — and we track which tests needed them
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',             // record a trace when a test fails and is retried
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/user.json' }, dependencies: ['setup'] },
    { name: 'webkit',   use: { ...devices['Desktop Safari'], storageState: 'e2e/.auth/user.json' }, dependencies: ['setup'] },
    { name: 'mobile',   use: { ...devices['Pixel 7'],        storageState: 'e2e/.auth/user.json' }, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
```

Key decisions in there:

- **`webServer`** starts your app before the tests. Testing the **production build** (`vite preview`) rather
  than the dev server catches build-only bugs (env vars, code splitting, minification).
- **`baseURL`** lets tests write `page.goto('/projects')`.
- **`projects`** run the same tests against several browsers/devices, and can depend on a `setup` project
  (we'll use that for authentication).
- **Traces on first retry** give you a full recording exactly when you need one, without slowing down green runs.

## Your first spec

```ts
// e2e/projects.spec.ts
import { test, expect } from '@playwright/test'

test('creates a project', async ({ page }) => {
  await page.goto('/projects')
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project name').fill('Apollo')
  await page.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByRole('heading', { name: 'Apollo' })).toBeVisible()
  await expect(page).toHaveURL(/\/projects\/[\w-]+$/)
})
```

That `{ page }` argument is a **fixture** — Playwright creates a fresh page in a fresh context for this test
and tears it down afterwards.

## Locators: find things the way users do

A **locator** is a *lazy description* of how to find an element. It is not resolved until you act on it,
and it is re-resolved on every retry — so it survives React re-renders that replace DOM nodes.

Priority list (the same philosophy as Testing Library):

| Prefer | Example | Why |
|---|---|---|
| `getByRole` | `page.getByRole('button', { name: 'Save' })` | What assistive tech sees; breaks only if UX breaks |
| `getByLabel` | `page.getByLabel('Email')` | Form fields as users identify them |
| `getByPlaceholder`, `getByText` | `page.getByText('No projects yet')` | Visible text |
| `getByTestId` | `page.getByTestId('kanban-column-done')` | Stable escape hatch when there's no good role/text |
| ❌ CSS / XPath | `page.locator('.btn-primary > span:nth-child(2)')` | Coupled to markup; breaks on every refactor |

Narrow locators by chaining and filtering:

```ts
const row = page.getByRole('row').filter({ hasText: 'Apollo' })
await row.getByRole('button', { name: 'Delete' }).click()

const dialog = page.getByRole('dialog', { name: 'Delete project?' })
await dialog.getByRole('button', { name: 'Delete' }).click()
```

Locators are **strict**: if `getByRole('button', { name: 'Delete' })` matches three buttons, the action
throws instead of guessing. That's a feature — it forces you to say *which* one.

:::warn title="Name matching differs from Testing Library"
In Playwright, a string `name` (and `getByText`, `getByLabel`) matches **case-insensitively and as a substring** by
default: `{ name: 'Delete' }` also matches "Delete project" and "Undelete". Testing Library does the opposite
(exact by default). Pass `{ name: 'Delete', exact: true }` or a RegExp like `/^Delete$/` when you need the whole
name — this is the #1 cause of surprise "strict mode violation: resolved to 2 elements" errors.
:::

:::quiz id=fe-23-q1 xp=10
Which locator is the most robust way to click the "Archive" action of the "Apollo" card?
- [ ] `page.locator('div.card:nth-child(3) button.icon-btn')`
- [ ] `page.locator('//div[@class="card"]//button[2]')`
- [x] `page.getByRole('article').filter({ hasText: 'Apollo' }).getByRole('button', { name: 'Archive' })`
- [ ] `page.getByText('Archive').first()`
> Role + accessible name, scoped to the card by its visible text, survives markup and style refactors and
> fails only when the UX actually changes. The CSS and XPath versions break when someone reorders cards or renames
> a class. `getByText('Archive').first()` looks user-facing but is the tempting trap: `.first()` switches off
> strictness and silently picks whichever "Archive" happens to come first — possibly on the wrong card.
:::

:::quiz id=fe-23-q5 xp=10
The project page has two buttons: **Delete** and **Delete project**. What does this line do?

```ts
await page.getByRole('button', { name: 'Delete' }).click()
```

- [ ] Clicks **Delete**, because it is the exact match
- [ ] Clicks whichever of the two buttons comes first in the DOM
- [x] Throws a strict mode violation, because the substring match resolves to both buttons
- [ ] Clicks both buttons in order
> Playwright's string `name` is a case-insensitive substring match, so "Delete" matches both. Locators are strict, so
> an action on a locator that resolves to 2 elements throws instead of guessing. Fix it with
> `{ name: 'Delete', exact: true }`. "Exact match wins" is how Testing Library behaves, not Playwright.
:::

## Auto-waiting and web-first assertions

The #1 source of flaky e2e tests in older tools was timing: clicking a button before it was enabled, reading
text before the fetch came back. Playwright attacks this in two places.

**Actions auto-wait.** `locator.click()` waits until the element is attached, visible, stable (not
animating), enabled and actually receives the click (not covered by an overlay). Only then does it click.

**Assertions retry.** `expect(locator)` matchers are *async* and poll until they pass (default 5 s):

```ts
// ✅ web-first: retries until the toast appears or 5 s pass
await expect(page.getByRole('status')).toHaveText('Saved')

// ❌ snapshot: reads the text ONCE, right now — races the network
expect(await page.getByRole('status').textContent()).toBe('Saved')

// ❌ never: arbitrary sleeps are slow AND still flaky
await page.waitForTimeout(2000)
```

:::warn title="The missing await"
`expect(locator).toHaveText('Saved')` **without** `await` creates a promise nobody waits for: the test moves on, may
finish green, and the failure (if any) surfaces later as a confusing error — or never. Every web-first assertion
needs `await`. Turn on `@typescript-eslint/no-floating-promises` (or `eslint-plugin-playwright`'s
`missing-playwright-await`) so CI catches it.
:::

For things that aren't a locator (an API value, a computed number), use `expect.poll`. It calls your function
repeatedly — by default after 100, 250, 500 and then every 1000 ms — until the matcher passes or the timeout hits:

```ts
test('the import job finishes', async ({ page, request }) => {
  // ... start the import in the UI ...
  await expect.poll(async () => {
    const res = await request.get('/api/jobs/42')
    const job = await res.json()
    return job.status
  }, { timeout: 10_000 }).toBe('done')
})
```

:::challenge id=fe-23-c1 lang=ts xp=50
title: Build your own expect.poll
Web-first assertions are just a retry loop. Implement `pollUntil(probe, predicate, opts)`:

- Call `probe()` (may be async). If `predicate(value)` is true, resolve with that value.
- Otherwise wait `opts.intervals[i]` ms (use the **last** interval for all further attempts) and try again.
- If more than `opts.timeout` ms have elapsed since the start (measured with `opts.now()`) when a check fails,
  reject with `Error('Timed out after <timeout>ms; last value: <JSON.stringify(last value)>')` — check the timeout
  **after** a failed check and **before** waiting.
- Waiting is done with the injected `opts.wait(ms)` so tests don't need real time. Never wait before the first
  probe, and never wait after a successful one.

hint: Record `const start = opts.now()` once, then loop forever: probe → check → timeout check → wait.
hint: `const ms = opts.intervals[Math.min(i, opts.intervals.length - 1)]`.

```ts starter
type PollOpts = { timeout: number; intervals: number[]; now: () => number; wait: (ms: number) => Promise<void> }

export async function pollUntil<T>(probe: () => T | Promise<T>, predicate: (v: T) => boolean, opts: PollOpts): Promise<T> {
  const v = await probe()
  return v
}
```

```ts solution
type PollOpts = { timeout: number; intervals: number[]; now: () => number; wait: (ms: number) => Promise<void> }

export async function pollUntil<T>(probe: () => T | Promise<T>, predicate: (v: T) => boolean, opts: PollOpts): Promise<T> {
  const start = opts.now()
  for (let i = 0; ; i++) {
    const v = await probe()
    if (predicate(v)) return v
    if (opts.now() - start > opts.timeout) {
      throw new Error(`Timed out after ${opts.timeout}ms; last value: ${JSON.stringify(v)}`)
    }
    await opts.wait(opts.intervals[Math.min(i, opts.intervals.length - 1)])
  }
}
```

```ts tests
function fakeClock() {
  let t = 0
  const waits: number[] = []
  return { now: () => t, wait: async (ms: number) => { waits.push(ms); t += ms }, waits }
}
test('resolves immediately when the first value matches', async () => {
  const c = fakeClock()
  await expect(pollUntil(() => 'done', (v) => v === 'done', { timeout: 1000, intervals: [100], ...c })).resolves.toBe('done')
  expect(c.waits).toEqual([])
})
test('retries with the interval schedule, reusing the last interval', async () => {
  const c = fakeClock()
  const values = ['queued', 'running', 'running', 'running', 'done']
  let n = 0
  const v = await pollUntil(async () => values[n++], (s) => s === 'done', { timeout: 10_000, intervals: [100, 250, 500], ...c })
  expect(v).toBe('done')
  expect(c.waits).toEqual([100, 250, 500, 500])
})
test('rejects after the timeout with the last value', async () => {
  const c = fakeClock()
  await expect(pollUntil(() => ({ status: 'running' }), () => false, { timeout: 1000, intervals: [400], ...c }))
    .rejects.toThrow('Timed out after 1000ms; last value: {"status":"running"}')
  expect(c.waits).toEqual([400, 400, 400])
})
```
:::

## Fixtures: reusable setup the Playwright way

`page`, `context`, `browser` and `request` are built-in fixtures. You can **extend** `test` with your own —
e.g. a page object, a seeded project, or an API client — and Playwright handles setup/teardown and only
creates fixtures a test actually asks for:

```ts
// e2e/fixtures.ts
import { test as base, expect } from '@playwright/test'

type Fixtures = { project: { id: string; name: string }; board: BoardPage }

export const test = base.extend<Fixtures>({
  // Seed data through the API (fast), not through the UI (slow)
  project: async ({ request }, use) => {
    const res = await request.post('/api/projects', { data: { name: `e2e-${crypto.randomUUID()}` } })
    const project = await res.json()
    await use(project)                                  // ← the test runs here
    await request.delete(`/api/projects/${project.id}`) // teardown, even if the test failed
  },
  board: async ({ page }, use) => { await use(new BoardPage(page)) },
})
export { expect }

// A small page object: intent-revealing methods, locators in one place
class BoardPage {
  constructor(private page: import('@playwright/test').Page) {}
  async open(id: string) { await this.page.goto(`/projects/${id}/board`) }
  column(name: string) { return this.page.getByRole('region', { name }) }
  async addCard(column: string, title: string) {
    await this.column(column).getByRole('button', { name: 'Add card' }).click()
    await this.page.getByLabel('Card title').fill(title)
    await this.page.keyboard.press('Enter')
  }
}
```

```ts
// e2e/board.spec.ts
import { test, expect } from './fixtures'

test('adds a card to To do', async ({ board, project }) => {
  await board.open(project.id)
  await board.addCard('To do', 'Write e2e tests')
  await expect(board.column('To do').getByRole('listitem')).toContainText(['Write e2e tests'])
})
```

:::pro title="Arrange through the API, act through the UI"
Real teams seed state via API calls or database fixtures and reserve UI clicks for the behaviour **under
test**. Logging in through the form in every test, or creating three projects by clicking, turns a 2-second
test into a 20-second one — and adds 20 seconds' worth of places to flake. Unique names
(`e2e-${uuid}`) keep parallel workers from colliding.
:::

## Authentication: log in once, reuse the state

Your app probably uses OIDC (see the security lesson): a redirect to Keycloak/Entra, a callback, cookies or
tokens. Doing that for every test is slow. Playwright's answer: a **setup project** logs in once and saves
the browser's cookies + localStorage to a file (`storageState`). Every other project starts already signed in.

```ts
// e2e/auth.setup.ts
import { test as setup, expect } from '@playwright/test'

const authFile = 'e2e/.auth/user.json'

setup('authenticate', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Now on the identity provider's page (a TEST realm / test tenant!)
  await page.getByLabel('Username').fill(process.env.E2E_USER!)
  await page.getByLabel('Password').fill(process.env.E2E_PASSWORD!)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible()
  await page.context().storageState({ path: authFile })
})
```

How the pieces connect: the `setup` project in the config matches `*.setup.ts`; the `chromium`/`webkit`/`mobile`
projects declare `dependencies: ['setup']`, so Playwright runs the setup first and only then starts them with
`storageState: 'e2e/.auth/user.json'` pre-loaded into every new browser context. The final `expect` before saving
matters: it waits until the redirect back to your app has finished, so you don't save a half-logged-in state.

Add `e2e/.auth/` to `.gitignore` — it contains live session cookies. For multi-role apps, create one file
per role (`admin.json`, `viewer.json`) and pick per test with `test.use({ storageState: 'e2e/.auth/admin.json' })`.

:::info title="What storageState does not capture"
It saves cookies and `localStorage` (and IndexedDB if you pass `indexedDB: true`), but **not `sessionStorage`**.
Some OIDC client libraries keep tokens in `sessionStorage` by default — then every test starts logged out again.
Either switch that library to `localStorage`/cookies for the test build, or restore `sessionStorage` yourself with
`context.addInitScript`. A BFF that keeps tokens in an HttpOnly cookie has no such problem.
:::

:::warn title="Test identities only"
The e2e user lives in a dedicated **test realm/tenant** with no access to real data, and its password is a CI
secret (`E2E_PASSWORD`) — never committed. If your BFF holds tokens in an HttpOnly cookie, `storageState`
captures that cookie too; it just works.
:::

## Network mocking with `page.route`

Sometimes you want the real backend (true e2e). Sometimes you want to isolate the frontend: to test an error
state, a slow response, or a 409 conflict that is hard to produce on demand. `page.route` intercepts requests
in the browser:

```ts
test('shows a conflict banner when someone else saved first', async ({ page }) => {
  await page.route('**/api/projects/42', async (route) => {
    if (route.request().method() === 'PUT') {
      return route.fulfill({ status: 409, json: { title: 'Conflict', currentVersion: 8 } })
    }
    return route.continue()        // let GETs hit the real API
  })

  await page.goto('/projects/42/settings')
  await page.getByLabel('Name').fill('Apollo 2')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('alert')).toContainText('Someone else edited this project')
})

test('renders the empty state', async ({ page }) => {
  await page.route('**/api/projects?*', (route) => route.fulfill({ json: { items: [], total: 0 } }))
  await page.goto('/projects')
  await expect(page.getByText('No projects yet')).toBeVisible()
})
```

Useful extras: `route.abort()` to simulate network failure, `page.waitForResponse('**/api/projects')` to
synchronise on a call, `context.setOffline(true)` to test the offline queue, and `page.clock` to control
timers (session expiry, debounce, "edited 5 minutes ago").

:::quiz id=fe-23-q2 xp=15
A test clicks **Save**, which sends `PUT /api/projects/42`, and then checks the toast. It fails 1 run in 20 on CI.
Which changes are good fixes? (Select all that apply.)
- [x] Replace `expect(await toast.textContent()).toBe('Saved')` with `await expect(toast).toHaveText('Saved')`
- [ ] Add `await page.waitForTimeout(3000)` after the click
- [x] Await the response explicitly, then still assert web-first: `const saved = page.waitForResponse('**/api/projects/42'); await save.click(); await saved; await expect(toast).toHaveText('Saved')`
- [ ] Set `retries: 10` so it always eventually passes
> Web-first assertions and explicit waits on real events remove the race. Note the order in the second fix: start
> `waitForResponse` **before** the click, otherwise a fast response can arrive before you start listening. A
> 3-second sleep seems to work locally but is pure guesswork — slow on every green run and still flaky on a slower
> runner. Huge retry counts hide the problem, and real users hit the same race. Keep in mind that
> `waitForResponse` alone only proves the request finished — React still has to parse it and re-render before the
> toast exists, so a one-shot `textContent()` right after `await saved` is still racy. Use `waitForResponse` when
> you also want to check the request or response itself, and keep the web-first assertion for the UI.
:::

## Accessibility gate with axe

Automated a11y checks don't replace manual testing with a keyboard and a screen reader, but they reliably catch
~30–50 % of issues: missing labels, low contrast, invalid ARIA, duplicate ids, buttons without names.
**`@axe-core/playwright`** runs Deque's axe engine inside the real page:

```ts
// e2e/a11y.spec.ts
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const pages = ['/', '/projects', '/projects/demo/board', '/settings']

for (const path of pages) {
  test(`no WCAG 2.2 AA violations on ${path}`, async ({ page }) => {
    await page.goto(path)
    await page.getByRole('main').waitFor()
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .exclude('#third-party-chat-widget')     // not ours; tracked separately
      .analyze()
    expect(results.violations).toEqual([])
  })
}

test('dialog is accessible when open', async ({ page }) => {
  await page.goto('/projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  expect(results.violations).toEqual([])
})
```

Scan the **states** users see, not just the initial page: open dialogs, error messages, dark mode, the mobile menu.

:::challenge id=fe-23-c2 lang=ts xp=50
title: A pragmatic axe gate
A legacy app has hundreds of existing violations, so the team adopts a ratchet: CI fails only on **serious or
critical** violations, ignoring rule ids on an allow-list (each with a ticket). Implement `gateViolations(violations, allow)`:

- Keep violations whose `impact` is `'serious'` or `'critical'` and whose `id` is **not** in `allow`.
- Return `{ pass, report }` where `pass` is true when nothing is kept, and `report` is an array of lines
  `"<impact> <id>: <help> (<n> nodes)"` sorted **critical first**, then by `id` alphabetically.

hint: `const rank = { critical: 0, serious: 1 }` makes sorting easy.
hint: `n` is `v.nodes.length`.

```ts starter
type Violation = { id: string; impact: 'minor' | 'moderate' | 'serious' | 'critical' | null; help: string; nodes: { target: string[] }[] }

export function gateViolations(violations: Violation[], allow: string[]): { pass: boolean; report: string[] } {
  return { pass: violations.length === 0, report: [] }
}
```

```ts solution
type Violation = { id: string; impact: 'minor' | 'moderate' | 'serious' | 'critical' | null; help: string; nodes: { target: string[] }[] }

export function gateViolations(violations: Violation[], allow: string[]): { pass: boolean; report: string[] } {
  const rank: Record<string, number> = { critical: 0, serious: 1 }
  const kept = violations
    .filter((v) => (v.impact === 'serious' || v.impact === 'critical') && !allow.includes(v.id))
    .sort((a, b) => rank[a.impact!] - rank[b.impact!] || a.id.localeCompare(b.id))
  return {
    pass: kept.length === 0,
    report: kept.map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.length} nodes)`),
  }
}
```

```ts tests
const node = { target: ['#x'] }
const v = (id: string, impact: any, n = 1) => ({ id, impact, help: `fix ${id}`, nodes: Array(n).fill(node) })
test('minor and moderate never fail the gate', () => {
  expect(gateViolations([v('region', 'moderate'), v('landmark-one-main', 'minor')], [])).toEqual({ pass: true, report: [] })
})
test('serious and critical fail and are reported, critical first then by id', () => {
  const r = gateViolations([v('label', 'critical', 2), v('color-contrast', 'serious', 5), v('button-name', 'critical')], [])
  expect(r.pass).toBe(false)
  expect(r.report).toEqual([
    'critical button-name: fix button-name (1 nodes)',
    'critical label: fix label (2 nodes)',
    'serious color-contrast: fix color-contrast (5 nodes)',
  ])
})
test('allow-listed rules are ignored', () => {
  expect(gateViolations([v('color-contrast', 'serious', 3)], ['color-contrast']).pass).toBe(true)
})
test('null impact is ignored', () => {
  expect(gateViolations([v('odd', null)], []).pass).toBe(true)
})
```
:::

## Debugging: UI mode, codegen and the trace viewer

```bash
npx playwright test --ui                 # watch mode with a timeline, DOM snapshots, locator picker
npx playwright test board.spec.ts --headed --project=chromium
npx playwright test --debug              # step through with the Inspector
npx playwright codegen localhost:5173    # click around, get locator code generated
npx playwright show-report               # open the HTML report
npx playwright show-trace trace.zip      # open a trace downloaded from CI
```

A **trace** records every action, a DOM snapshot before/after it, console logs, network requests and
the source line. When a test fails on CI only, you download the `playwright-report` artifact, open the trace,
and scrub through the run as if you were there. This single feature is why debugging Playwright failures is
dramatically cheaper than with older tools.

## Running in CI

```yaml
# .github/workflows/e2e.yml
name: e2e
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium webkit
      - run: npx playwright test
        env:
          E2E_USER: ${{ secrets.E2E_USER }}
          E2E_PASSWORD: ${{ secrets.E2E_PASSWORD }}
      - uses: actions/upload-artifact@v5   # action majors move often — bump all three to the current ones
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
```

Why each step is there: `--with-deps` installs the Linux system libraries the browsers need (without it, WebKit
fails to launch on a fresh runner); secrets come from the repository settings and never appear in logs;
`if: ${{ !cancelled() }}` uploads the report **even when tests failed** — which is exactly when you need it.

For large suites, **shard** across machines: run `npx playwright test --shard=1/4` … `--shard=4/4` in a job matrix
with `--reporter=blob`, upload each `blob-report/` folder, then a final job runs
`npx playwright merge-reports --reporter html ./all-blob-reports` to produce one combined report.
Many teams run Chromium on every PR and the full browser matrix nightly.

:::job title="What e2e looks like on a real team"
- A small **smoke** suite (sign-in, main page loads, create the core entity) runs on every PR and after every
  deploy against staging.
- The broader suite runs nightly or on merge to main.
- A test that flakes gets **quarantined** (`test.fixme` + a ticket) the same day — a red-but-ignored suite is
  worse than no suite, because people learn to click "re-run".
- The HTML report and traces are attached to every CI run; "works on my machine" arguments end there.
:::

## Flaky-test hygiene

A flaky test passes and fails on the same code. Common causes and cures:

| Cause | Cure |
|---|---|
| Asserting a snapshot value instead of retrying | Web-first assertions (`await expect(locator)…`) |
| Arbitrary `waitForTimeout` | Wait for a real signal: a locator, a response, a URL |
| Tests sharing data (same project name, same user's settings) | Unique data per test, API-seeded fixtures, teardown |
| Order dependence (test B needs test A's leftovers) | Each test arranges its own state; `fullyParallel: true` surfaces this |
| Animations / transitions | `reducedMotion: 'reduce'` in `use`, or assert the final state |
| Time and dates | `page.clock.setFixedTime(...)`, fixed timezone/locale in config |
| Third-party scripts (analytics, chat widgets) | `page.route` them to an empty response |

Run `npx playwright test --repeat-each=20 board.spec.ts` to prove a fix before un-quarantining.

:::quiz id=fe-23-q3 xp=10
Why should e2e tests run against `vite build` + `vite preview` rather than `vite dev` in CI?
- [ ] The dev server can't be started from a config file
- [x] It tests what you ship: minified, code-split, with production env vars — bugs that only exist in the build get caught
- [ ] Playwright doesn't support hot module replacement
- [ ] The preview server is faster at compiling TypeScript
> The dev server transforms files on demand and differs from the production bundle in many ways (env handling,
> chunking, tree-shaking). Testing the build catches "works in dev, blank page in prod". The other options are
> false: Playwright starts the dev server from `webServer` just as happily, it doesn't care about HMR, and
> `vite preview` compiles nothing — it only serves the already-built `dist/` folder.
:::

:::quiz id=fe-23-q4 xp=10
What does `storageState` store, and why is the file git-ignored?
- [x] Cookies and localStorage of a signed-in context — it is effectively a live session credential
- [ ] The Playwright test results — they are too large for git
- [ ] The browser binaries — they are platform-specific
- [ ] The React component state at the end of each test
> Anyone with that file can impersonate the test user until the session expires. Generate it in CI from secrets,
> never commit it. Test results and browser binaries are git-ignored too, but for size/platform reasons — they have
> nothing to do with `storageState`. Playwright never sees React component state.
:::

:::lab id=fe-23-lab1 xp=120
title: Add Playwright + an a11y gate to your Vite app
Use the app you built in earlier lessons (or `npm create vite@latest e2e-lab -- --template react-ts`).

1. Install: `npm i -D @playwright/test @axe-core/playwright` and `npx playwright install --with-deps chromium`
   (`--with-deps` may ask for `sudo` on Linux to install system libraries).
2. Create `playwright.config.ts` with `testDir: './e2e'`, `baseURL: 'http://localhost:4173'`,
   `trace: 'on-first-retry'`, `retries: process.env.CI ? 2 : 0`, and a `webServer` running
   `npm run build && npm run preview -- --port 4173`.
3. Add `"test:e2e": "playwright test"` to `package.json` scripts and `test-results/`, `playwright-report/`,
   `e2e/.auth/` to `.gitignore`.
4. Write `e2e/smoke.spec.ts`:

```ts
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('home page renders its main heading', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('counter increments', async ({ page }) => {
  await page.goto('/')
  const button = page.getByRole('button', { name: /count is/i })
  await button.click()
  await expect(button).toHaveText(/count is 1/)
})

test('home page has no serious a11y violations', async ({ page }) => {
  await page.goto('/')
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(blocking.map((v) => v.id)).toEqual([])
})
```

(The selectors assume the Vite React template: an `<h1>` and a `count is 0` button. Adapt them if your app differs.)

5. Run `npm run test:e2e`. Expected output (timings and worker count vary):

```text
Running 3 tests using 3 workers
  ✓  1 › e2e/smoke.spec.ts:4:5 › home page renders its main heading (0.6s)
  ✓  2 › e2e/smoke.spec.ts:9:5 › counter increments (0.7s)
  ✓  3 › e2e/smoke.spec.ts:16:5 › home page has no serious a11y violations (1.1s)
  3 passed (6.2s)
```

:::info title="If the a11y test fails on a fresh template"
The template's light-grey hint text can fail `color-contrast` (a `serious` rule). That is a genuine finding, not a
broken test: darken the colour in `App.css` until the test passes — you've just used the gate as intended.
:::

6. Break something on purpose: replace a button's text with an icon only (no `aria-label`) and watch the axe test
   fail with `button-name`. Fix it with `aria-label`.
7. If your app calls an API, add an error-state test with `page.route('**/api/**', (route) => route.fulfill({ status: 500, json: { title: 'boom' } }))`
   and assert your error UI (e.g. `await expect(page.getByRole('alert')).toBeVisible()`). A test without an
   assertion always passes, so don't commit one.
8. Make a test fail on purpose, run `npx playwright test --trace on`, then `npx playwright show-report` → open the
   failed test → click the trace.
9. Optional: add the GitHub Actions workflow from this lesson and push a branch.

- [ ] `npm run test:e2e` starts the built app and all three smoke tests pass (after fixing any real contrast finding)
- [ ] I saw the axe test fail on an unlabeled button and fixed it
- [ ] I opened a trace and found the failing step, its DOM snapshot and network log
- [ ] Generated folders and `e2e/.auth/` are in `.gitignore`
:::

## Recap

- E2E tests drive a **real browser** through critical journeys; keep them few, fast and focused.
- Prefer **role/label locators**; locators are lazy, strict and re-resolved on every retry. String names match
  case-insensitively as substrings — use `exact: true` when you need the whole name.
- **Auto-waiting actions + web-first assertions** remove timing races — and every `expect(locator)` needs `await`.
  Never `waitForTimeout`.
- **Fixtures** (`test.extend`) package setup/teardown; seed via API, act via UI.
- Log in once in a **setup project** and reuse `storageState`; keep it out of git.
- **`page.route`** mocks errors, empty states and 409s that are hard to produce for real.
- **`@axe-core/playwright`** is a cheap, automatic accessibility gate — scan dialogs and error states too.
- Traces + HTML report on CI make failures debuggable; quarantine flaky tests the same day.

:::cards id=fe-23-cards1 xp=15 title="Playwright"
Q: What is a locator?
A: A lazy, re-resolvable description of how to find an element; resolved only when you act or assert, and re-resolved on every retry.
Q: Which locator should you reach for first?
A: `getByRole(role, { name })`, then `getByLabel`, then text; `getByTestId` as an escape hatch; avoid CSS/XPath.
Q: What does "web-first assertion" mean?
A: `await expect(locator).toHaveText(...)` — retries until it passes or times out, instead of checking once.
Q: How do you avoid logging in through the UI in every test?
A: A setup project signs in once and saves `storageState`; other projects load it via `use.storageState`.
Q: How do you test a 409 or 500 response without breaking the backend?
A: `page.route(pattern, route => route.fulfill({ status: 409, json: … }))`.
Q: Does `getByRole('button', { name: 'Save' })` match a "Save draft" button?
A: Yes — Playwright string names are case-insensitive substrings by default. Add `exact: true` (Testing Library is exact by default).
Q: What happens if you forget `await` on `expect(locator).toBeVisible()`?
A: The assertion promise is never awaited, so the test can pass without checking anything. Lint with `no-floating-promises`.
Q: What is the trace viewer for?
A: Time-travel debugging of a run: actions, DOM snapshots, console, network — ideal for CI-only failures.
Q: What does `forbidOnly: !!process.env.CI` prevent?
A: A forgotten `test.only` silently skipping the rest of the suite in CI.
Q: What fraction of a11y issues can automated axe checks find?
A: Roughly a third to a half — still needs keyboard and screen-reader testing.
:::
