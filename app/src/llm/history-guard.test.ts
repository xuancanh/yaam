import { describe, expect, it } from 'vitest'

// GUARD: every assistant runtime (monitor, watcher, chat, addon agent/editor)
// retains a private ApiMessage[] history and caps it. A raw history.shift() /
// history.pop() cap can split a tool_use/tool_result pair or leave an orphaned
// tool_result opener — providers then reject EVERY later call, silently muting
// that assistant (watchers: 08840bd; monitor status cards: 4e54fe2). The same
// copy-pasted cap reintroduced the bug three times, so this test bans the raw
// pattern outright: cap via capToolHistory/sanitizeToolHistory (tool loops) or
// capChatHistory/sanitizeChatHistory (chat). If you add a legitimate new
// helper that owns the invariant itself, add its file to ALLOWED with a note.

const ALLOWED = new Set([
  'llm/tool-loop.ts', // owns sanitizeToolHistory / capToolHistory
  'domains/chat/agent.ts', // owns sanitizeChatHistory / capChatHistory (attachment-aware)
  'domains/chat/runner.ts', // rebuildChatHistory: text-only messages, no tool rounds exist
])

const RAW_CAP = /history\s*\.\s*(shift|pop)\s*\(\s*\)/

// every source file, as raw text, resolved at build time by vite
const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

describe('history-cap guard', () => {
  it('no runtime caps a provider history with a raw shift()/pop()', () => {
    const offenders: string[] = []
    for (const [key, text] of Object.entries(sources)) {
      // keys are relative to this file's dir: '../domains/…' or './…' for llm/
      const path = key.startsWith('./') ? `llm/${key.slice(2)}` : key.replace(/^\.\.\//, '')
      if (ALLOWED.has(path) || /\.test\.tsx?$/.test(path)) continue
      text.split('\n').forEach((line, i) => {
        if (RAW_CAP.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, [
      'Raw history cap found — this pattern corrupts retained provider histories',
      '(split tool pairs / orphaned tool_result openers) and silently mutes the',
      'assistant. Use capToolHistory (llm/tool-loop) or capChatHistory (chat/agent):',
      ...offenders,
    ].join('\n')).toEqual([])
    // the guard must actually be seeing the tree (vite glob resolved)
    expect(Object.keys(sources).length).toBeGreaterThan(100)
  })
})
