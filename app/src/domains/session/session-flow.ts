// Session flow: a compact timeline of what an agent did (prompts, tool calls,
// replies) parsed from its tailed CLI transcript. Claude Code transcripts and
// Codex rollouts are both understood. Kept per session in a capped ring with
// subscribers, outside the store (it changes on every transcript line).

export type FlowKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'mcp' | 'other'

export interface FlowStep {
  id: string
  at: number
  type: 'prompt' | 'tool' | 'say'
  kind?: FlowKind
  /** tool name as the CLI reports it */
  tool?: string
  label: string
  /** file path for read/edit steps (opens in the Files panel) */
  path?: string
  status?: 'running' | 'ok' | 'error'
  callId?: string
}

const CAP = 400
const rings = new Map<string, FlowStep[]>()
const subs = new Map<string, Set<() => void>>()
let seq = 0

export function flowFor(id: string): readonly FlowStep[] {
  return rings.get(id) ?? []
}
export function onFlow(id: string, cb: () => void): () => void {
  const set = subs.get(id) ?? new Set()
  set.add(cb)
  subs.set(id, set)
  return () => { set.delete(cb) }
}
export function dropFlow(id: string): void {
  rings.delete(id)
  subs.delete(id)
}
export function resetFlows(): void {
  rings.clear()
  subs.clear()
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
const oneLine = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** Category + one-line label for a tool call. */
export function describeTool(name: string, input: Record<string, unknown>): { kind: FlowKind; label: string; path?: string } {
  const n = name.toLowerCase()
  const path = str(input.file_path) || str(input.path) || str(input.notebook_path)
  if (n.startsWith('mcp__')) {
    const [, server, tool] = name.split('__')
    return { kind: 'mcp', label: `${server} · ${tool ?? ''}` }
  }
  if (['read', 'view', 'ls', 'notebookread'].includes(n)) return { kind: 'read', label: path ? base(path) : name, path: path || undefined }
  if (['edit', 'multiedit', 'write', 'notebookedit', 'str_replace_editor', 'create'].includes(n)) return { kind: 'edit', label: path ? base(path) : name, path: path || undefined }
  if (n === 'apply_patch') {
    const patch = str(input.input) || str(input.patch) || str(input.raw)
    const files = [...patch.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map(m => m[1].trim())
    return { kind: 'edit', label: files.length ? files.map(base).join(', ') : 'apply patch', path: files[0] }
  }
  if (['bash', 'shell', 'local_shell', 'exec_command', 'container.exec'].includes(n)) {
    const cmd = Array.isArray(input.command) ? (input.command as unknown[]).map(String).join(' ') : str(input.command) || str(input.cmd)
    // codex wraps commands as ["bash","-lc","<script>"]
    return { kind: 'run', label: oneLine(cmd.replace(/^(ba|z)?sh -l?c\s+/, '')) || name }
  }
  if (['grep', 'glob', 'search', 'find'].includes(n)) return { kind: 'search', label: oneLine(str(input.pattern) || str(input.query) || name) }
  if (['webfetch', 'websearch', 'web_search', 'fetch'].includes(n)) return { kind: 'web', label: oneLine(str(input.url) || str(input.query) || name) }
  if (['task', 'agent', 'subagent'].includes(n)) return { kind: 'agent', label: oneLine(str(input.description) || str(input.prompt) || 'subagent') }
  if (['todowrite', 'update_plan', 'exitplanmode'].includes(n)) return { kind: 'plan', label: n === 'todowrite' ? 'updated the todo list' : 'updated the plan' }
  return { kind: 'other', label: name }
}

/** Steps contained in one transcript record, plus results that settle
 *  earlier tool steps (by call id). */
export function stepsFromRecord(rec: Record<string, unknown>): { steps: Omit<FlowStep, 'id'>[]; results: { callId: string; error: boolean }[] } {
  const at = Date.parse(str(rec.timestamp)) || Date.now()
  const steps: Omit<FlowStep, 'id'>[] = []
  const results: { callId: string; error: boolean }[] = []
  // ---- Claude Code ----
  if (rec.type === 'assistant' || rec.type === 'user') {
    const msg = rec.message as { content?: unknown } | undefined
    const content = msg?.content
    if (rec.type === 'user' && typeof content === 'string') {
      if (!rec.isMeta && !/^<(command|local-command|system)/.test(content.trim())) steps.push({ at, type: 'prompt', label: oneLine(content, 160) })
      return { steps, results }
    }
    for (const b of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
      if (b.type === 'tool_use') {
        const d = describeTool(str(b.name), (b.input ?? {}) as Record<string, unknown>)
        steps.push({ at, type: 'tool', tool: str(b.name), status: 'running', callId: str(b.id), ...d })
      } else if (b.type === 'tool_result') {
        results.push({ callId: str(b.tool_use_id), error: b.is_error === true })
      } else if (b.type === 'text' && rec.type === 'assistant' && str(b.text).trim()) {
        steps.push({ at, type: 'say', label: oneLine(str(b.text), 160) })
      } else if (b.type === 'text' && rec.type === 'user' && !rec.isMeta && str(b.text).trim() && !/^<|^\[Request interrupted/.test(str(b.text).trim())) {
        steps.push({ at, type: 'prompt', label: oneLine(str(b.text), 160) })
      }
    }
    return { steps, results }
  }
  // ---- Codex rollouts ----
  const p = rec.payload as Record<string, unknown> | undefined
  if (!p) return { steps, results }
  if (rec.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call')) {
    let input: Record<string, unknown> = {}
    const raw = p.arguments ?? p.input ?? p.action
    if (typeof raw === 'string') { try { input = JSON.parse(raw) } catch { input = { input: raw } } } else if (raw && typeof raw === 'object') input = raw as Record<string, unknown>
    const name = str(p.name) || (p.type === 'local_shell_call' ? 'local_shell' : 'tool')
    steps.push({ at, type: 'tool', tool: name, status: 'running', callId: str(p.call_id) || str(p.id), ...describeTool(name, input) })
  } else if (rec.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
    const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
    results.push({ callId: str(p.call_id), error: /"exit_code":\s*[1-9]|"success":\s*false|^error/i.test(out) })
  } else if (rec.type === 'event_msg' && p.type === 'user_message' && str(p.message).trim()) {
    steps.push({ at, type: 'prompt', label: oneLine(str(p.message), 160) })
  } else if (rec.type === 'event_msg' && p.type === 'agent_message' && str(p.message).trim()) {
    steps.push({ at, type: 'say', label: oneLine(str(p.message), 160) })
  }
  return { steps, results }
}

/** Fold parsed transcript records into a session's flow ring. */
export function ingestFlow(id: string, records: Record<string, unknown>[]): void {
  if (!records.length) return
  const ring = rings.get(id) ?? []
  let changed = false
  for (const rec of records) {
    const { steps, results } = stepsFromRecord(rec)
    for (const s of steps) { ring.push({ ...s, id: `f${++seq}` }); changed = true }
    for (const r of results) {
      for (let i = ring.length - 1; i >= 0; i--) {
        if (ring[i].callId === r.callId) { ring[i] = { ...ring[i], status: r.error ? 'error' : 'ok' }; changed = true; break }
      }
    }
  }
  if (ring.length > CAP) ring.splice(0, ring.length - CAP)
  rings.set(id, ring)
  if (changed) for (const cb of subs.get(id) ?? []) cb()
}

/** Headline numbers for the flow header. */
export function flowStats(steps: readonly FlowStep[]): { tools: number; errors: number; files: number; byKind: Partial<Record<FlowKind, number>> } {
  const byKind: Partial<Record<FlowKind, number>> = {}
  const files = new Set<string>()
  let tools = 0, errors = 0
  for (const s of steps) {
    if (s.type !== 'tool') continue
    tools++
    if (s.status === 'error') errors++
    if (s.kind) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1
    if (s.kind === 'edit' && s.path) files.add(s.path)
  }
  return { tools, errors, files: files.size, byKind }
}
