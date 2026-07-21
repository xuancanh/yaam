// Heuristics for detecting when a CLI is waiting on the user, and extracting
// numbered TUI menu options from a settled terminal screen.
import type { EscOption } from '../../core/types'

// Explicit interactive markers for plain (non-TUI) streams. These only appear
// when a CLI is genuinely blocked on the user — looser signals (bare
// "permission"/"confirm" substrings, a trailing colon) fired on ordinary
// output like "permission denied", "error: …", or "Done:".
export const PLAIN_PROMPT_MARKER_RE = /(\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|\(yes\/no\)|yes\/no|password:|press enter to|\(esc to cancel\))/i

// Strong markers for full-screen TUI approval dialogs (Claude Code, Codex, …).
export const TUI_PROMPT_RE = /(do you want to (proceed|make this edit|run|allow)|requires approval|don'?t ask again|yes, and|grant (access|permission)|allow this (command|tool|action)|\[y\/n\]|\(y\/n\)|password:|enter to select|[↑↓]\/[↑↓] to navigate|❯\s*\d+\.)/i
export const QUESTION_LINE_RE = /(do you want[^?]*\??|requires approval|allow [^?]*\??|permission|\[y\/n\]|\(y\/n\))/i
// selection menus usually put the actual question on its own line ending in "?"
export const QUESTION_MARK_LINE_RE = /^[^│┌└─]*\S[^?]*\?\s*$/

// numbered dialog options, with optional ❯ cursor: "❯ 1. Yes" / "2. No"
export const OPTION_RE = /^\s*[│]?\s*(❯)?\s*(\d+)[.)]\s+(.+?)\s*[│]?\s*$/

export interface PromptDetection {
  /** true while a TUI shows its generating marker — the turn is not over. */
  busy: boolean
  /** true when the settled content looks like it is waiting on the user. */
  promptDetected: boolean
  /** best-guess question text (only meaningful when promptDetected). */
  question: string
}

/**
 * Decide whether settled terminal `content` is waiting on the user. `alt` marks
 * a full-screen TUI (judged by its rendered screen) vs a plain stream tail.
 * Pure — the caller owns the surrounding session state and dedup.
 */
export function detectPrompt(content: string[], alt: boolean): PromptDetection {
  // Plain streams are judged by their LAST non-empty line only: a real prompt
  // is the freshest thing on screen (anything below it means the CLI moved
  // on), and older tail lines are output, not questions.
  const lastLine = [...content].reverse().find(l => l.trim())?.trim() ?? ''
  // TUIs show a busy marker while generating — the turn is NOT over, so any
  // question-looking text on screen is transient.
  const busy = alt && /esc to interrupt|ctrl\+c to interrupt/i.test(content.join('\n'))
  const promptDetected = !busy && (alt
    ? TUI_PROMPT_RE.test(content.join('\n'))
    : PLAIN_PROMPT_MARKER_RE.test(lastLine) || /\?\s*$/.test(lastLine))
  const question = (
    content.find(l => QUESTION_LINE_RE.test(l)) ||
    content.find(l => QUESTION_MARK_LINE_RE.test(l.trim())) ||
    lastLine
  ).trim()
  return { busy, promptDetected, question }
}

// Volatile glyphs that change every frame without changing meaning: braille /
// block spinners, progress-bar fills, and the like. Stripped before comparing
// two settled screens so a redraw that only advances a spinner does not read as
// new output (which would re-arm the settle loop and re-wake the watcher).
// eslint-disable-next-line no-misleading-character-class
const SPINNER_RE = /[⠀-⣿▀-▟◐◓◑◒◴◵◶◷⣾⣽⣻⢿⡿⣟⣯⣷]/g

/**
 * A stable identity for a settled terminal screen: drop decoration/noise lines,
 * strip spinner glyphs, and collapse whitespace so cosmetic redraws compare
 * equal. Used to tell "genuinely new output" from "same screen, redrawn". Pure.
 */
export function stableScreenKey(content: string[]): string {
  return content
    .map(l => l.replace(SPINNER_RE, '').replace(/\s+/g, ' ').trim())
    .filter(l => l && !NOISE_LINE_RE.test(l))
    .join('\n')
}

// Lines that are just decoration/noise, not meaningful screen identity.
const NOISE_LINE_RE = /^[\s│┌└├─╭╰╮╯>#$%❯•·*=-]*$/

/** Extract numbered TUI choices and the visible cursor from settled screen rows. */
export function extractOptions(lines: string[]): { options: EscOption[]; cursorNum: number } {
  const options: EscOption[] = []
  let cursorNum = 1
  for (const line of lines) {
    const m = line.match(OPTION_RE)
    if (!m) continue
    const num = parseInt(m[2], 10)
    if (options.some(o => o.num === num)) continue
    options.push({ num, label: m[3].trim().slice(0, 60) })
    if (m[1]) cursorNum = num
  }
  return options.length >= 2 ? { options, cursorNum } : { options: [], cursorNum: 1 }
}
