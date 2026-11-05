import { useCallback, type MouseEvent } from 'react'
import { renderMarkdown, renderInline } from '../../engine/markdown.ts'

/** Renders trusted lesson Markdown (it ships with the site) and wires up code-block copy buttons. */
export function Markdown({ md, inline = false, className = 'prose' }: { md: string; inline?: boolean; className?: string }) {
  const onClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLButtonElement | null
    if (!btn) return
    const code = btn.closest('.code-block')?.querySelector('code')?.textContent ?? ''
    navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = 'Copied ✓'
      setTimeout(() => { btn.textContent = 'Copy' }, 1400)
    })
  }, [])
  if (inline) return <span className={className} dangerouslySetInnerHTML={{ __html: renderInline(md) }} />
  return <div className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
}
