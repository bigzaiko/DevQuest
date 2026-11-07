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

// base: './' makes the build work under any sub-path, e.g. https://<user>.github.io/DevQuest/
export default defineConfig({
  base: './',
  plugins: [react(), lessonMeta()],
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
