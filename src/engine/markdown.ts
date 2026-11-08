import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import csharp from 'highlight.js/lib/languages/csharp'
import sql from 'highlight.js/lib/languages/sql'
import pgsql from 'highlight.js/lib/languages/pgsql'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import powershell from 'highlight.js/lib/languages/powershell'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import http from 'highlight.js/lib/languages/http'
import css from 'highlight.js/lib/languages/css'
import ini from 'highlight.js/lib/languages/ini'
import diff from 'highlight.js/lib/languages/diff'
import plaintext from 'highlight.js/lib/languages/plaintext'
import nginx from 'highlight.js/lib/languages/nginx'
import markdownLang from 'highlight.js/lib/languages/markdown'

const langs: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  javascript, typescript, xml, csharp, sql, pgsql, bash, shell, powershell, json, yaml, dockerfile, http, css, ini, diff, plaintext, nginx, markdown: markdownLang,
}
for (const [n, l] of Object.entries(langs)) hljs.registerLanguage(n, l)

const ALIAS: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  cs: 'csharp', 'c#': 'csharp', sh: 'bash', zsh: 'bash', console: 'shell', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  yml: 'yaml', docker: 'dockerfile', html: 'xml', xaml: 'xml', csproj: 'xml', toml: 'ini', env: 'ini', text: 'plaintext', txt: 'plaintext', md: 'markdown', psql: 'sql',
}

export function highlight(code: string, lang: string): string {
  const l = ALIAS[lang] || lang
  if (l && hljs.getLanguage(l)) {
    try { return hljs.highlight(code, { language: l, ignoreIllegals: true }).value } catch { /* fallthrough */ }
  }
  return escapeHtml(code)
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const marked = new Marked({ gfm: true, breaks: false })
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slugify(text)}">${this.parser.parseInline(tokens)}</h${depth}>`
    },
    code({ text, lang }) {
      const l = (lang || '').trim().split(/\s+/)[0] || 'text'
      const label = l === 'text' || l === 'plaintext' ? '' : l
      return `<div class="code-block"><div class="code-head"><span>${escapeHtml(label)}</span><button class="copy-btn" type="button" aria-label="Copy code">Copy</button></div><pre><code class="hljs language-${escapeHtml(l)}">${highlight(text, l)}</code></pre></div>`
    },
    table(token) {
      // wrap tables so they scroll on small screens
      const header = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('')
      const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('')
      return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const external = /^https?:\/\//.test(href)
      return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}${external ? ' target="_blank" rel="noreferrer noopener"' : ''}>${text}</a>`
    },
  },
})

export function slugify(s: string) {
  return 'h-' + s.toLowerCase().replace(/<[^>]+>|`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

const cache = new Map<string, string>()
export function renderMarkdown(md: string): string {
  let html = cache.get(md)
  if (!html) { html = sanitize(marked.parse(md, { async: false }) as string); cache.set(md, html) }
  return html
}
export function renderInline(md: string): string {
  return sanitize(marked.parseInline(md, { async: false }) as string)
}

// Defence in depth: lessons come from this repo, but rendered HTML is still sanitized so a bad
// lesson (or a malicious pull request) can't inject scripts, event handlers or javascript: links.
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}
