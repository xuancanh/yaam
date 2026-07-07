// Heuristics for detecting when a CLI is waiting on the user, and extracting
// numbered TUI menu options from a settled terminal screen.
import type { EscOption } from '../../core/types'

// y/n prompts, permission questions, confirmation menus.
export const PROMPT_RE = /(\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|yes\/no|do you want|would you like|allow this|allow .*\?|permission|approve\?|confirm|proceed\?|continue\?|password:|are you sure|press enter to|\(esc to cancel\))/i

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
  const lastLine = content[content.length - 1] ?? ''
  // TUIs show a busy marker while generating — the turn is NOT over, so any
  // question-looking text on screen is transient.
  const busy = alt && /esc to interrupt|ctrl\+c to interrupt/i.test(content.join('\n'))
  const promptDetected = !busy && (alt
    ? TUI_PROMPT_RE.test(content.join('\n'))
    : PROMPT_RE.test(content.slice(-3).join('\n')) || /[?:]\s*$/.test(lastLine.trim()))
  const question = (
    content.find(l => QUESTION_LINE_RE.test(l)) ||
    content.find(l => QUESTION_MARK_LINE_RE.test(l.trim())) ||
    lastLine
  ).trim()
  return { busy, promptDetected, question }
}

// Output that reads like something went wrong — used to flag a session card
// deterministically when there is no LLM monitor to judge the outcome.
const ERROR_LINE_RE = /\b(error|errno|failed|failure|fatal|panic|traceback|exception|unhandled|segmentation fault|core dumped|cannot |could ?n[o']t |command not found|not recognized|no such file|permission denied|access denied|connection refused|timed out|unable to)\b/i
// Lines that are just decoration/noise, not a meaningful "last thing it said".
const NOISE_LINE_RE = /^[\s│┌└├─╭╰╮╯>#$%❯•·*=-]*$/

/**
 * A no-LLM stand-in for the session monitor's status update: from a settled
 * terminal tail, pick the last meaningful line as a one-line summary and, if the
 * recent output looks like an error, surface it as an action-needed flag. Pure.
 */
export function deterministicStatus(content: string[]): { summary: string; actionNeeded?: string } {
  const clean = content.map(l => l.trim()).filter(l => l && !NOISE_LINE_RE.test(l))
  const summary = (clean[clean.length - 1] ?? '').slice(0, 140)
  // scan only the recent tail so old, already-handled errors don't re-flag
  const errLine = [...clean].reverse().slice(0, 8).find(l => ERROR_LINE_RE.test(l))
  return errLine ? { summary, actionNeeded: `Possible error — ${errLine.slice(0, 120)}` } : { summary }
}

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
