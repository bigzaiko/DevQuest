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

// base: './' makes the build work under any sub-path, e.g. https://<user>.github.io/DevQuest/
export default defineConfig({
  base: './',
  plugins: [react(), lessonMeta(), csp()],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
  // the sandbox iframe has an opaque origin (Origin: null) and loads its scripts cross-origin;
  // GitHub Pages answers with Access-Control-Allow-Origin: *, `vite preview` needs this
  preview: { cors: { origin: 'null' } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: 'index.html' },  // sandbox.html is built separately (vite.sandbox.config.ts)
    },
  },
})
