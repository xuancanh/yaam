// Addon runtime: package validation, the API surface exposed to addon code,
// and execution of addon tools / hooks. Addons are data (a JSON package) —
// views render in a sandboxed iframe; tool handlers and hooks are JS run in
// the app context against this curated API, so only install trusted packages.
import type { Addon, AddonTool, AppState } from './types'

export interface AddonApi {
  /** read-only snapshot: sessions, tasks, crons, events, totals */
  getState: () => Record<string, unknown>
  /** type a message into a session (Enter pressed separately) */
  sendToSession: (sessionId: string, text: string) => void
  /** launch a command as a new session; returns its id or null */
  launchSession: (command: string, cwd?: string, name?: string) => string | null
  /** toast in the UI */
  flash: (text: string) => void
  /** entry in the Activity timeline */
  logEvent: (text: string) => void
  /** notification in the bell popover */
  notify: (title: string, detail: string) => void
}

export function addonSnapshot(s: AppState): Record<string, unknown> {
  return {
    sessions: s.agents.filter(a => !a.archived).map(a => ({
      id: a.id, name: a.name, status: a.status,
      task: a.task ?? null, summary: a.summary ?? null, actionNeeded: a.actionNeeded ?? null,
      cwd: a.cwd ?? null, cost: Number(a.cost.toFixed(3)), used: Number(a.used.toFixed(2)),
    })),
    tasks: s.tasks.map(t => ({ title: t.title, col: t.col })),
    crons: s.crons.map(c => ({ name: c.name, schedule: c.schedule, on: c.on, last: c.last })),
    events: s.events.slice(0, 10).map(e => ({ time: e.time, type: e.type, text: e.text })),
    totals: {
      cost: Number(s.agents.reduce((n, a) => n + a.cost, 0).toFixed(3)),
      used: Number(s.agents.reduce((n, a) => n + a.used, 0).toFixed(2)),
      running: s.agents.filter(a => a.status === 'running').length,
    },
  }
}

/** Parse + validate a package JSON string. Throws with a readable message. */
export function parseAddonPackage(json: string): Omit<Addon, 'id' | 'enabled' | 'source' | 'createdAt'> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('not valid JSON')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) throw new Error('package needs a "name"')
  const version = typeof raw.version === 'string' ? raw.version : '0.0.0'
  const icon = typeof raw.icon === 'string' && raw.icon ? String(raw.icon).slice(0, 2) : '◆'
  const html = typeof raw.html === 'string' && raw.html.trim() ? raw.html : undefined
  const tools: AddonTool[] = Array.isArray(raw.tools)
    ? (raw.tools as unknown[]).flatMap(t => {
        const o = t as Record<string, unknown>
        if (typeof o?.name !== 'string' || typeof o?.handler !== 'string') return []
        return [{
          name: o.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
          description: typeof o.description === 'string' ? o.description : '',
          input_schema: (o.input_schema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          handler: o.handler,
        }]
      })
    : []
  const hooksRaw = (raw.hooks ?? {}) as Record<string, unknown>
  const hooks = {
    onSessionExit: typeof hooksRaw.onSessionExit === 'string' ? hooksRaw.onSessionExit : undefined,
    onNeedsInput: typeof hooksRaw.onNeedsInput === 'string' ? hooksRaw.onNeedsInput : undefined,
    masterPromptAppend: typeof hooksRaw.masterPromptAppend === 'string' ? hooksRaw.masterPromptAppend : undefined,
  }
  if (!html && !tools.length && !hooks.onSessionExit && !hooks.onNeedsInput && !hooks.masterPromptAppend) {
    throw new Error('package has no view, tools, or hooks')
  }
  return {
    name, version, icon, html, tools: tools.length ? tools : undefined,
    hooks: (hooks.onSessionExit || hooks.onNeedsInput || hooks.masterPromptAppend) ? hooks : undefined,
    desc: typeof raw.description === 'string' ? raw.description : undefined,
    author: typeof raw.author === 'string' ? raw.author : undefined,
  }
}

/** Serialize an installed addon back into a shareable package. */
export function exportAddonPackage(a: Addon): string {
  return JSON.stringify({
    manifest: 2,
    name: a.name,
    version: a.version,
    icon: a.icon,
    description: a.desc,
    author: a.author,
    html: a.html,
    tools: a.tools,
    hooks: a.hooks,
  }, null, 2)
}

/** Tool definitions contributed by enabled addons (namespaced). */
export function addonToolDefs(s: AppState) {
  return s.addons.filter(a => a.enabled && a.tools?.length).flatMap(a =>
    a.tools!.map(t => ({
      name: `addon_${t.name}`,
      description: `[addon: ${a.name}] ${t.description}`,
      input_schema: t.input_schema,
    })))
}

/** Prompt snippets contributed by enabled addons. */
export function addonPromptAppends(s: AppState): string {
  const parts = s.addons
    .filter(a => a.enabled && a.hooks?.masterPromptAppend)
    .map(a => `[addon: ${a.name}]\n${a.hooks!.masterPromptAppend}`)
  return parts.length ? `\n\nADDON DIRECTIVES (installed by the user):\n${parts.join('\n\n')}` : ''
}

async function runHandler(source: string, arg: unknown, api: AddonApi): Promise<unknown> {
  const fn = new Function('input', 'api', `"use strict";\n${source}`)
  return await fn(arg, api)
}

/** Execute an addon-contributed Master tool (name arrives namespaced). */
export async function execAddonTool(s: AppState, name: string, input: Record<string, unknown>, api: AddonApi): Promise<string> {
  const plain = name.replace(/^addon_/, '')
  for (const a of s.addons) {
    if (!a.enabled) continue
    const tool = a.tools?.find(t => t.name === plain)
    if (!tool) continue
    try {
      const out = await runHandler(tool.handler, input, api)
      return typeof out === 'string' ? out : JSON.stringify(out ?? 'ok')
    } catch (e) {
      return `addon tool error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return `no enabled addon provides tool ${plain}`
}

/** Fire a lifecycle hook across all enabled addons (errors contained). */
export async function execAddonHook(
  s: AppState,
  hook: 'onSessionExit' | 'onNeedsInput',
  event: Record<string, unknown>,
  api: AddonApi,
): Promise<void> {
  for (const a of s.addons) {
    const src = a.enabled ? a.hooks?.[hook] : undefined
    if (!src) continue
    try {
      await runHandler(src, event, api)
    } catch (e) {
      api.logEvent(`addon "${a.name}" ${hook} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
