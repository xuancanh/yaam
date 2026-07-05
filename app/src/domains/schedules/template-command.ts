// Translate an agent template into the real CLI invocation for its agent type.
import type { AgentTemplate, AgentType } from '../../core/types'

/** Quote an arbitrary string for safe use as one POSIX shell argument. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Build the CLI command for an agent template. Ephemeral templates use the
 * CLI's one-shot mode (claude -p / codex exec); interactive templates start a
 * long-running session seeded with the prompt. `{task}` in the prompt is
 * replaced by the task text; without the placeholder the task is appended.
 */
export function buildTemplateCommand(tpl: AgentTemplate, type: AgentType | undefined, task?: string, contract?: string): string {
  const bin = (type?.model ?? tpl.typeId).trim() || 'claude'
  const base = tpl.prompt.includes('{task}')
    ? tpl.prompt.replaceAll('{task}', task ?? '')
    : [tpl.prompt, task ?? ''].filter(Boolean).join('\n\n')
  // the verification contract (criteria + goal) rides AFTER the composed prompt
  const prompt = [base.trim(), (contract ?? '').trim()].filter(Boolean).join('\n\n')
  const kind = type?.probe
    ?? (/(^|\/)claude$/.test(bin) ? 'claude' : /(^|\/)codex$/.test(bin) ? 'codex' : undefined)
  const extra = tpl.extraArgs.trim()
  const parts: string[] = [bin]

  if (kind === 'claude') {
    if (tpl.mode === 'ephemeral') parts.push('-p')
    if (tpl.model.trim()) parts.push('--model', shQuote(tpl.model.trim()))
    if (tpl.systemPrompt.trim()) parts.push('--append-system-prompt', shQuote(tpl.systemPrompt.trim()))
    if (tpl.approval === 'edits') parts.push('--permission-mode', 'acceptEdits')
    if (tpl.approval === 'full') parts.push('--dangerously-skip-permissions')
    if (extra) parts.push(extra)
    if (prompt) parts.push(shQuote(prompt))
    return parts.join(' ')
  }

  if (kind === 'codex') {
    if (tpl.mode === 'ephemeral') parts.push('exec', '--skip-git-repo-check')
    if (tpl.model.trim()) parts.push('-m', shQuote(tpl.model.trim()))
    if (tpl.approval === 'safe') parts.push('--sandbox', 'read-only')
    if (tpl.approval === 'edits') parts.push('--sandbox', 'workspace-write')
    if (tpl.approval === 'full') parts.push('--dangerously-bypass-approvals-and-sandbox')
    if (extra) parts.push(extra)
    const full = [tpl.systemPrompt.trim(), prompt].filter(Boolean).join('\n\n')
    if (full) parts.push(shQuote(full))
    return parts.join(' ')
  }

  if (extra) parts.push(extra)
  const full = [tpl.systemPrompt.trim(), prompt].filter(Boolean).join('\n\n')
  if (full) parts.push(shQuote(full))
  return parts.join(' ')
}
