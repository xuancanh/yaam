// Pure file-path detection for terminal ctrl/cmd+click links. Finds path-like
// tokens in one rendered terminal line and reports where they sit so the xterm
// link provider can underline them. URLs are excluded here — the web-links
// addon owns those. Pure string logic, unit-testable without xterm.

export interface PathMatch {
  /** 0-based index of the whole underlined token in the line */
  index: number
  /** length of the underlined token (includes any :line[:col] suffix) */
  length: number
  /** the openable path — :line[:col] suffix and trailing punctuation stripped */
  path: string
  /** 1-based line number parsed from a :line[:col] suffix, if present */
  line?: number
}

// Three shapes, in priority order:
//  1. anchored: starts with / ./ ../ or ~/  (absolute, home, or dot-relative)
//  2. relative with a slash: src/foo/bar.ts, a/b/c
//  3. bare filename with an extension: package.json, main.rs
// All may carry a :line or :line:col suffix. The char class deliberately
// excludes shell/markup delimiters so quotes and brackets end a match.
const P = String.raw`[\w.@+%-]`
const PATH_RE = new RegExp(
  String.raw`(?:~/|\.{1,2}/|/)(?:${P}+/)*${P}+/?` + // 1. anchored
  String.raw`|${P}+(?:/${P}+)+` +                   // 2. relative with slash
  String.raw`|${P}+\.[A-Za-z][A-Za-z0-9]{0,7}`,     // 3. bare file.ext
  'g',
)

/** Chars that may sit directly before a path start (or the line start). */
const BOUNDARY_BEFORE = new Set([' ', '\t', '"', "'", '`', '(', '[', '<', '=', ','])

/** Find every openable file-path token in one terminal line. */
export function filePathMatches(text: string): PathMatch[] {
  const out: PathMatch[] = []
  PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_RE.exec(text))) {
    let tok = m[0]
    const start = m.index
    // must sit on a word boundary — rejects the "//host/path" tail of a URL
    // (preceded by ':' or '/') and tokens glued to other text
    const before = start === 0 ? '' : text[start - 1]
    if (before && !BOUNDARY_BEFORE.has(before)) continue
    // drop trailing sentence punctuation ("see src/app.ts.")
    tok = tok.replace(/[.,;]+$/, '')
    if (!tok || tok === '.' || tok === '..' || tok === '/' || tok === '~/') continue
    // a :line[:col] suffix immediately after the token is part of the link
    const suffix = /^:(\d+)(?::\d+)?/.exec(text.slice(start + tok.length))
    const line = suffix ? parseInt(suffix[1], 10) : undefined
    const full = tok + (suffix ? suffix[0] : '')
    // needs a path signal: a slash, a dot-extension, or a home anchor —
    // rejects bare words that only matched via the relative alternation
    if (!/[/~]/.test(tok) && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(tok)) continue
    out.push({ index: start, length: full.length, path: tok, line })
  }
  return out
}

/** Resolve a matched path against the session cwd (kept pure for tests).
 *  Absolute and ~ paths pass through; relative ones join onto the cwd. */
export function resolveTermPath(path: string, cwd: string): string {
  if (path.startsWith('/') || path.startsWith('~')) return path
  const rel = path.replace(/^\.\//, '')
  const base = cwd.replace(/\/+$/, '')
  return base ? `${base}/${rel}` : rel
}
