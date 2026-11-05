import type { CalloutBlock } from '../../engine/parse.ts'
import { Markdown } from './Markdown.tsx'

const META: Record<CalloutBlock['variant'], { icon: string; label: string }> = {
  tip: { icon: '💡', label: 'Tip' },
  info: { icon: 'ℹ️', label: 'Good to know' },
  warn: { icon: '⚠️', label: 'Watch out' },
  pro: { icon: '🧠', label: 'Pro move' },
  job: { icon: '💼', label: 'On the job' },
}

export function Callout({ b }: { b: CalloutBlock }) {
  const m = META[b.variant]
  return (
    <aside className={`callout callout-${b.variant}`}>
      <div className="callout-title"><span aria-hidden="true">{m.icon}</span>{b.title || m.label}</div>
      <Markdown md={b.md} />
    </aside>
  )
}
