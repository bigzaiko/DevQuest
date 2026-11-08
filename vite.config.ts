import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { parseLesson, lessonMaxXp } from './src/engine/parse.ts'

/**
 * `import x from './lesson.md?meta'` → a tiny JSON summary of the lesson (frontmatter, exercise list,
 * headings). The map/search/achievements only need this, so the full lesson text is lazy-loaded.
 */
function lessonMeta(): Plugin {
  return {
    name: 'devquest-lesson-meta',
    load(id) {
      if (!id.endsWith('.md?meta')) return
      const file = id.slice(0, -'?meta'.length)
      this.addWatchFile(file)
      const l = parseLesson(readFileSync(file, 'utf8'))
      const info = {
        meta: l.meta,
        maxXp: lessonMaxXp(l),
        errors: l.errors,
        headings: l.blocks.flatMap((b) => (b.kind === 'md' ? [...b.md.matchAll(/^## (.+)$/gm)].map((m) => m[1]) : [])),
        exercises: l.exercises.map((e) => ({
          id: e.id, kind: e.kind, xp: e.xp,
          title: 'title' in e ? e.title : undefined,
          react: e.kind === 'challenge' ? e.react : undefined,
          mode: e.kind === 'challenge' ? e.mode : undefined,
        })),
      }
      return `export default ${JSON.stringify(info)}`
    },
  }
}

/**
 * Content-Security-Policy for the production page (a <meta> tag: GitHub Pages can't set headers).
 * Build only — the dev server injects inline scripts for hot reload.
 *  - script-src: own files only; 'wasm-unsafe-eval' lets PGlite (PostgreSQL in WASM) compile.
 *  - learner code runs in the Web Worker / sandbox iframe, which have their own context.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

function csp(): Plugin {
  return {
    name: 'devquest-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  }
}

/**
 * Private regions (folders src/content/private-NAME, gitignored) are for local study only. They are left out
 * of every build unless DEVQUEST_PRIVATE=1; `npm run dev` includes them. The globs in
 * src/content/{index,tracks}.ts exclude them with '!./private-*' patterns, which this removes.
 */
function privateRegions(): Plugin {
  let enabled = false
  return {
    name: 'devquest-private',
    enforce: 'pre',
    config(_, env) { enabled = env.command === 'serve' || process.env.DEVQUEST_PRIVATE === '1' },
    transform(code, id) {
      if (!enabled || !/src\/content\/(index|tracks)\.ts$/.test(id)) return
      return code.replace(/,\s*'!\.\/private-\*\/[^']*'/g, '')
    },
    generateBundle(_, bundle) {
      if (enabled) return
      for (const chunk of Object.values(bundle)) {
        const ids = chunk.type === 'chunk' ? Object.keys(chunk.modules) : []
        const leak = ids.find((m) => m.includes('/src/content/private-'))
        if (leak) this.error(`private content would be published: ${leak}`)
      }
    },
  }
}

// base: './' makes the build work under any sub-path, e.g. https://<user>.github.io/DevQuest/
export default defineConfig({
  base: './',
  plugins: [privateRegions(), react(), lessonMeta(), csp()],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: 'index.html' },  // sandbox.html is built separately (vite.sandbox.config.ts)
    },
  },
})
