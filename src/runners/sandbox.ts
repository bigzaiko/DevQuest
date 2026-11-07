// The React sandbox iframe (sandbox.html). Receives code via postMessage, runs the tests in its own
// document, then renders the preview component. Replies with the verdict.
import * as React from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { createDomKit } from './dom.ts'
import { runChallenge, compile, type ChallengeInput } from './execute.ts'

const kit = createDomKit(React, ReactDOMClient, document)
let previewRoot: ReactDOMClient.Root | null = null

function postHeight() {
  parent.postMessage({ source: 'devquest-sandbox', type: 'height', height: document.documentElement.scrollHeight }, '*')
}
new ResizeObserver(postHeight).observe(document.documentElement)

function renderPreview(code: string, name: string) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  previewRoot?.unmount()
  previewRoot = null
  document.body.innerHTML = ''
  const host = document.createElement('div')
  host.id = 'preview'
  document.body.appendChild(host)
  try {
    const js = compile(code, true) + `\n;return typeof ${name} !== 'undefined' ? ${name} : null;`
    const req = (m: string) => { if (m === 'react') return React; if (m.startsWith('react-dom')) return ReactDOMClient; throw new Error(`Module ${m} not available`) }
    const C = new Function('React', 'require', 'exports', 'module', js)(React, req, {}, { exports: {} })
    if (!C) { host.textContent = `Preview: component "${name}" not found.`; return }
    previewRoot = ReactDOMClient.createRoot(host)
    previewRoot.render(React.createElement(ErrorBoundary, null, React.createElement(C)))
  } catch (e) {
    host.innerHTML = `<pre style="color:#c0392b;white-space:pre-wrap">${String((e as Error).message)}</pre>`
  }
}

class ErrorBoundary extends React.Component<{ children?: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return React.createElement('pre', { style: { color: '#c0392b', whiteSpace: 'pre-wrap' } }, `Render error: ${this.state.error.message}`)
    return this.props.children
  }
}

window.addEventListener('message', async (e: MessageEvent) => {
  const d = e.data
  if (!d || d.source !== 'devquest-host') return
  if (d.type === 'run') {
    const { id, ch, code, preview } = d as { id: number; ch: ChallengeInput; code: string; preview?: string }
    previewRoot?.unmount(); previewRoot = null
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    let verdict
    try {
      verdict = await runChallenge(ch, code, { React, ReactDOMClient, dom: kit })
    } catch (err) {
      verdict = { pass: false, results: [], logs: [], error: String((err as Error)?.message ?? err) }
    }
    kit.cleanup()
    if (preview && ch.mode === 'code') renderPreview((ch.setup ? ch.setup + '\n' : '') + code, preview)
    parent.postMessage({ source: 'devquest-sandbox', type: 'result', id, verdict }, '*')
    setTimeout(postHeight, 50)
  } else if (d.type === 'preview') {
    renderPreview(d.code, d.preview)
    setTimeout(postHeight, 50)
  }
})

parent.postMessage({ source: 'devquest-sandbox', type: 'ready' }, '*')
