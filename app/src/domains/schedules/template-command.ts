// Translate an agent template into the real CLI invocation for its agent type.
// Per-CLI flag knowledge lives in core/agent-adapters; this module only
// composes the prompt and dispatches.
import { adapterFor, shQuote } from '../../core/agent-adapters'
import type { HeadlessSpec } from '../../core/agent-adapters'
import type { AgentTemplate, AgentType } from '../../core/types'

export { shQuote }

/** Arguments for a CLI with no adapter: extras, then one prompt argument. */
function genericArgs(spec: HeadlessSpec): string[] {
  const parts: string[] = []
  if (spec.extraArgs.trim()) parts.push(spec.extraArgs.trim())
  const full = [spec.systemPrompt.trim(), spec.prompt].filter(Boolean).join('\n\n')
  if (full) parts.push(shQuote(full))
  return parts
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
  const spec: HeadlessSpec = {
    mode: tpl.mode, model: tpl.model, systemPrompt: tpl.systemPrompt,
    approval: tpl.approval, extraArgs: tpl.extraArgs, prompt,
  }
  const adapter = adapterFor(type, bin)
  return [bin, ...(adapter ? adapter.buildArgs(spec) : genericArgs(spec))].join(' ')
}
