// End-to-end self-test against the PRODUCTION build in a real browser:
//  1) opens every lesson page and fails on load errors / console errors,
//  2) runs every code challenge (solution must pass, starter must fail) through the real
//     Web Worker / React iframe sandbox, and every SQL challenge through PGlite.
// Usage: npm run build && npm run selftest   (CHROMIUM_PATH=/usr/bin/chromium to use a system browser)
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const PORT = 4179
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
const stop = () => { try { server.kill('SIGTERM') } catch { /* gone */ } }
process.on('exit', stop)
const base = `http://localhost:${PORT}/`
for (let i = 0; i < 60; i++) { try { if ((await fetch(base)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)) }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] })
const page = await browser.newPage()
const consoleErrors: string[] = []
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`) })

await page.goto(`${base}?selftest#/`)
await page.waitForFunction(() => (window as any).__devquestSelfTest, null, { timeout: 30000 })
const ids: string[] = await page.evaluate(() => (window as any).__devquestSelfTest.lessons())
const failures: { lesson: string; id: string; problem: string }[] = []
let checked = 0

// 1) render every lesson page
for (const id of ids) {
  consoleErrors.length = 0
  await page.evaluate((h) => { location.hash = h }, `#/lesson/${id}`)
  try {
    await page.waitForFunction(() => document.querySelector('.lesson .prose, .lesson .ex') || document.querySelector('[role=alert]'), null, { timeout: 20000 })
  } catch { failures.push({ lesson: id, id, problem: 'lesson did not render within 20s' }) }
  const alert = await page.evaluate(() => document.querySelector('.lesson [role=alert]')?.textContent || '')
  if (/Could not load/.test(alert)) failures.push({ lesson: id, id, problem: alert })
  for (const e of consoleErrors) failures.push({ lesson: id, id, problem: `render: ${e}`.slice(0, 400) })
}
// also the other pages
for (const h of ['#/', '#/profile', '#/playground', '#/exam/frontend', '#/exam/all', '#/track/desktop']) {
  consoleErrors.length = 0
  await page.evaluate((x) => { location.hash = x }, h)
  await page.waitForTimeout(800)
  for (const e of consoleErrors) failures.push({ lesson: h, id: h, problem: `render: ${e}`.slice(0, 400) })
}

// 2) run every challenge in the browser runners
await page.evaluate(() => { location.hash = '#/' })
for (const [i, id] of ids.entries()) {
  const r = await page.evaluate((lid) => (window as any).__devquestSelfTest.testLesson(lid), id).catch((e: Error) => ({ checked: 0, failures: [{ lesson: id, id, problem: `crashed: ${e.message}` }] }))
  checked += r.checked
  failures.push(...r.failures)
  process.stdout.write(`\r${i + 1}/${ids.length} lessons · ${checked} challenges · ${failures.length} failure(s)   `)
}
console.log()
await browser.close()
stop()
for (const f of failures) console.log(`✖ ${f.lesson} [${f.id}] ${f.problem}`)
console.log(failures.length ? `✖ ${failures.length} failure(s)` : `✔ browser self-test passed: ${ids.length} lessons rendered, ${checked} challenges run`)
process.exit(failures.length ? 1 : 0)
