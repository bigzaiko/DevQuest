import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'

export interface CodeEditorProps {
  value: string
  onChange?: (v: string) => void
  lang: 'js' | 'ts' | 'jsx' | 'tsx' | 'sql'
  onRun?: () => void
  readOnly?: boolean
  minLines?: number
  label?: string
}

/** CodeMirror 6 wrapper. Ctrl/⌘+Enter runs. The value prop only resets the doc when it changes externally. */
export function CodeEditor({ value, onChange, lang, onRun, readOnly = false, minLines = 6, label = 'Code editor' }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const runRef = useRef(onRun)
  const changeRef = useRef(onChange)
  runRef.current = onRun
  changeRef.current = onChange

  useEffect(() => {
    const language = lang === 'sql'
      ? sql({ dialect: PostgreSQL, upperCaseKeywords: true })
      : javascript({ typescript: lang === 'ts' || lang === 'tsx', jsx: lang === 'jsx' || lang === 'tsx' })
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language,
          oneDark,
          keymap.of([indentWithTab]),
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { runRef.current?.(); return true } }])),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.theme({
            '&': { backgroundColor: '#1b1814' },
            '.cm-gutters': { backgroundColor: '#1b1814', borderRight: '1px solid rgba(255,255,255,0.05)' },
            '.cm-content': { minHeight: `${minLines * 1.6}em`, caretColor: '#ff8a3d' },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.035)' },
            '&.cm-focused .cm-cursor': { borderLeftColor: '#ff8a3d' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(255,90,44,0.25) !important' },
          }),
          EditorView.updateListener.of((u) => { if (u.docChanged) changeRef.current?.(u.state.doc.toString()) }),
        ],
      }),
    })
    view.current = v
    return () => v.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, readOnly])

  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} />
}
