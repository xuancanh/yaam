// Tiny regex syntax highlighter shared by the addon Source view and the file
// viewer. Escape first, then colorize — output is HTML for dangerouslySetInnerHTML.

export type HighlightLang = 'js' | 'html' | 'json' | 'text'

/** Escape source text before inserting syntax-highlight markup around it. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export const HL_COLORS = {
  comment: '#5B6472',
  string: '#7FE3B0',
  keyword: '#C77DFF',
  number: '#F5C451',
  tag: '#7FD1FF',
  attr: '#E8A87C',
}

const C = HL_COLORS

/** Apply the lightweight shared JavaScript highlighter to escaped source. */
export function highlightJs(code: string): string {
  return escapeHtml(code).replace(
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(&#?\w+;)?('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\b(const|let|var|function|return|if|else|for|while|do|await|async|new|typeof|instanceof|of|in|try|catch|finally|throw|class|extends|switch|case|break|continue|default|null|undefined|true|false|this|pub|fn|impl|struct|enum|match|use|mut|def|import|from|export|interface|type|None|True|False|self)\b|\b(\d+(?:\.\d+)?)\b/g,
    (m, comment, _amp, str, kw, num) => {
      if (comment) return `<span style="color:${C.comment};font-style:italic">${comment}</span>`
      if (str) return `<span style="color:${C.string}">${(_amp || '') + str}</span>`
      if (kw) return `<span style="color:${C.keyword}">${kw}</span>`
      if (num) return `<span style="color:${C.number}">${num}</span>`
      return m
    },
  )
}

/** Highlight HTML structure and inline script/style bodies without a parser. */
export function highlightHtml(code: string): string {
  return escapeHtml(code).replace(
    /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?)([a-zA-Z][\w-]*)|((?:[\w-]+)=)("(?:[^"])*")/g,
    (m, comment, open, tag, attr, val) => {
      if (comment) return `<span style="color:${C.comment};font-style:italic">${comment}</span>`
      if (open !== undefined && tag) return `${open}<span style="color:${C.tag}">${tag}</span>`
      if (attr && val) return `<span style="color:${C.attr}">${attr}</span><span style="color:${C.string}">${val}</span>`
      return m
    },
  )
}

/** Dispatch source text to the matching regex highlighter. */
export function highlight(code: string, lang: HighlightLang): string {
  if (lang === 'js' || lang === 'json') return highlightJs(code)
  if (lang === 'html') return highlightHtml(code)
  return escapeHtml(code)
}

/** Pick a highlighter for a filename (the JS highlighter covers most C-likes). */
/** Infer the supported highlight mode from a file name or extension. */
export function langForFile(name: string): HighlightLang {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['html', 'htm', 'xml', 'svg', 'vue', 'svelte'].includes(ext)) return 'html'
  if (['json', 'jsonl'].includes(ext)) return 'json'
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'rb', 'php', 'sh', 'zsh', 'bash', 'toml', 'yaml', 'yml', 'css', 'scss'].includes(ext)) return 'js'
  return 'text'
}
