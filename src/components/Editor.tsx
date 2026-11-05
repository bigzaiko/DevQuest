import { lazy, Suspense } from 'react'
import type { CodeEditorProps } from './CodeEditor.tsx'

const CodeEditor = lazy(() => import('./CodeEditor.tsx').then((m) => ({ default: m.CodeEditor })))

/** Lazy CodeMirror — keeps the editor (~400 kB) out of the first page load. */
export function Editor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<pre style={{ margin: 0, padding: '0.6rem 1rem', minHeight: `${(props.minLines ?? 6) * 1.6}em`, fontFamily: 'var(--font-mono)', fontSize: 13.5, color: '#cfc6bb', whiteSpace: 'pre-wrap' }}>{props.value}</pre>}>
      <CodeEditor {...props} />
    </Suspense>
  )
}
