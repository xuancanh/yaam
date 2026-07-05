// Master turn harness: call the model, execute tools, verify claims.
import type { AppState } from '../../types'
import { buildCfg, callApi } from '../../llm/client'
import { runTool, TOOLS } from './tools'
import { addonToolDefs } from '../../addons'
import type { MasterExec } from './tools'
import { chatHistory, systemPrompt } from './prompt'

export interface MasterTurnResult {
  text: string
  thinking: string
}

/**
 * Run one Master turn: call the model, execute any tool calls against the app,
 * and loop until the model stops. Intermediate narration, reasoning, and tool
 * calls are collected as a collapsible "thinking" trace; only the final text
 * is the reply.
 */
export async function runMasterTurn(
  getState: () => AppState,
  exec: MasterExec,
  eventNote?: string,
): Promise<MasterTurnResult> {
  const s0 = getState()
  const cfg = buildCfg(s0.settings)
  const messages = chatHistory(s0, eventNote)
  const trace: string[] = []
  let finalTexts: string[] = []
  const usedTools: string[] = []
  let integrityRetried = false

  for (let i = 0; i < 10; i++) {
    // re-describe state each iteration so tool effects are visible to the model
    const res = await callApi(cfg, systemPrompt(getState()), messages, [...TOOLS, ...addonToolDefs(getState())])
    const stepTexts: string[] = []
    for (const block of res.content) {
      if (block.type === 'thinking' && block.text) trace.push(block.text)
      if (block.type === 'text' && block.text) stepTexts.push(block.text)
    }
    if (res.stop_reason !== 'tool_use') {
      finalTexts = stepTexts
      // integrity check: replies that claim actions must be backed by real
      // tool calls this turn — otherwise force the model to act or restate
      const finalText = stepTexts.join(' ')
      const claimsAction = /\b(i(?:'ve| have)? (?:sent|asked|told|instructed|approved|pressed)|let me (?:check|send|ask|see)|i'?ll (?:check|send|ask|watch)|instruction (?:is |was )?(?:sent|in))\b/i.test(finalText)
      const acted = usedTools.some(t => ['send_to_session', 'press_keys', 'launch_session', 'stop_session', 'read_session'].includes(t))
      if (claimsAction && !acted && !integrityRetried) {
        integrityRetried = true
        messages.push({ role: 'assistant', content: finalText })
        messages.push({
          role: 'user',
          content: '[integrity check — not the user] Your reply claims or promises an action, but you called no session tool this turn. Do it now with the proper tool (send_to_session / press_keys / read_session) and then report only what the returned screen shows — or restate your reply without claiming any action.',
        })
        trace.push('⚠ integrity check: claimed action without tool call — retrying')
        continue
      }
      break
    }
    // narration before tool calls belongs to the trace, not the reply
    trace.push(...stepTexts)
    const results = []
    for (const b of res.content.filter(x => x.type === 'tool_use')) {
      usedTools.push(b.name || '')
      const result = await runTool(b.name || '', b.input || {}, exec)
      trace.push(`→ ${b.name}(${JSON.stringify(b.input || {})})`)
      trace.push(`← ${result.length > 300 ? result.slice(0, 300) + '…' : result}`)
      results.push({ type: 'tool_result', tool_use_id: b.id, content: result })
    }
    messages.push({ role: 'assistant', content: res.content })
    messages.push({ role: 'user', content: results })
  }

  return {
    text: finalTexts.join('\n\n').trim(),
    thinking: trace.join('\n').trim(),
  }
}
