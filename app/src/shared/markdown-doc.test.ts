import { describe, expect, it } from 'vitest'
import { markdownDoc, renderMarkdown, slugify } from './markdown-doc'
import type { DocTheme } from './markdown-doc'

const THEME = { bg: '#000', text: '#fff', text2: '#eee', mut: '#999', dim: '#777', line: '#222', line2: '#333', accent: '#F5C451', codeBg: '#111', bg3: '#111', sans: 'sans-serif', mono: 'monospace', hl: {} } satisfies DocTheme

describe('renderMarkdown', () => {
  it('gives headings unique GitHub-style anchors', () => {
    const html = renderMarkdown('# Getting Started!\n\n## Setup\n\n## Setup')
    expect(html).toContain('id="getting-started"')
    expect(html).toContain('id="setup"')
    expect(html).toContain('id="setup-1"')
  })
  it('renders GFM tables, task lists, nested lists and strikethrough', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n  - nested\n\n~~old~~')
    expect(html).toContain('<table>')
    expect(html).toMatch(/<input[^>]*checked[^>]*type="checkbox"|<input[^>]*type="checkbox"[^>]*checked/)
    expect(html.match(/<ul>/g)?.length).toBe(2)
    expect(html).toContain('<del>old</del>')
  })
  it('highlights known code languages and escapes the rest', () => {
    expect(renderMarkdown('```js\nconst x = 1\n```')).toContain('data-lang="js"')
    expect(renderMarkdown('```\n<b>\n```')).toContain('&lt;b&gt;')
  })
  it('keeps raw HTML (the sandboxed frame is the boundary) and drops front matter', () => {
    const html = renderMarkdown('---\ntitle: x\n---\n<details><summary>More</summary>hi</details>')
    expect(html).toContain('<details>')
    expect(html).not.toContain('title: x')
  })
})

describe('markdownDoc', () => {
  it('wraps the body in a themed standalone document with the link bridge', () => {
    const doc = markdownDoc('# Hi', THEME)
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<main><h1 id="hi">')
    expect(doc).toContain('yaam-preview:open')
  })
})

it('slugify strips punctuation and markup', () => {
  expect(slugify('Hello, <code>World</code>!')).toBe('hello-world')
})
