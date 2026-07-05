// Master orchestration turn: the tool-executing loop between the user and the
// agent fleet. Builds the MasterExec (launch/send/keys/settings/schedules/
// addons/tasks) under the tool-permission gates, runs turns until the queue
// drains. Extracted from the provider; operates on the stable refs/callbacks
// in `ctx`.
import type { MutableRefObject } from 'react'
import type { Addon, AppState } from '../../core/types'
import type { AddonApi } from '../../core/addons'
import type { MasterExec } from '../../master'
import { hasCreds, runMasterTurn } from '../../master'
import { execAddonTool, parseAddonPackage } from '../../core/addons'
import { mkId } from '../../shared/id'
import { humanizeCron } from '../schedules/cron'
import { KEYMAP, sendLineToSession, wait } from '../session/command'
import { PERM_ORDER, SHELLS } from '../../core/data'
import { isAbortError } from '../../core/abort-registry'
import * as native from '../../core/native'

export interface MasterCtx {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  masterBusyRef: MutableRefObject<boolean>
  masterQueued: MutableRefObject<{ note?: string } | null>
  lastEventRef: MutableRefObject<{ note: string; at: number } | null>
  toolApprovalsRef: MutableRefObject<Set<string>>
  userStoppedRef: MutableRefObject<Set<string>>
  /** tear down an addon's runtime state (agent registries + editor history) on removal */
  disposeAddon: (addonId: string) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string }) => string | null
  launchFromTemplate: (templateId: string, task?: string, workspaceId?: string, cwdOverride?: string, forceEphemeral?: boolean, contract?: string) => string | null
  armResponseWatch: (id: string) => void
  sessionScreenTail: (id: string) => string
  logEvent: (type: import('../../core/types').EventType, agentId: string | null, text: string) => void
  flash: (t: string) => void
  applyAgentStatus: (sid: string, task?: string, summary?: string, actionNeeded?: string) => void
  setNeedsInput: (id: string, question: string) => void
  makeAddonApi: (addonId: string) => AddonApi
  /** write a line to a session's PTY (routes through the shared command as the
   *  master actor); defaults to the direct PTY line when unwired */
  sendLine?: (sid: string, text: string) => void
  /** current cancellation signal for the Master turn (aborted on workspace delete) */
  signal?: () => AbortSignal | undefined
}

/** Run Master turns until its queue drains, applying tool-permission gates. */
export async function runMasterLoop(ctx: MasterCtx, eventNote?: string) {
  const { stateRef, dispatch } = ctx
  if (!hasCreds(stateRef.current.settings)) return
  if (eventNote) {
    const last = ctx.lastEventRef.current
    if (last && last.note === eventNote && Date.now() - last.at < 10000) return
    ctx.lastEventRef.current = { note: eventNote, at: Date.now() }
  }
  if (ctx.masterBusyRef.current) {
    ctx.masterQueued.current = { note: eventNote ?? ctx.masterQueued.current?.note }
    return
  }
  ctx.masterBusyRef.current = true
  dispatch(s => ({ ...s, masterBusy: true }))

  // permission gates: global Tools registry + per-session overrides
  // Apply the global Auto/Ask/Off policy before a Master tool side effect.
  const catalogGate = (toolId: string): string | null => {
    const perm = stateRef.current.toolsCatalog.find(t => t.id === toolId)?.perm ?? 'Auto'
    if (perm === 'Off') return `blocked: the user disabled "${toolId}" in the Tools registry`
    if (perm === 'Approval') return `blocked: "${toolId}" is set to Approval — ask the user to change it in Tools`
    if (perm === 'Ask first') {
      if (ctx.toolApprovalsRef.current.delete(toolId)) return null // consume the one-shot approval
      dispatch(s2 => s2.pendingToolApprovals.some(pa => pa.toolId === toolId)
        ? s2
        : { ...s2, pendingToolApprovals: s2.pendingToolApprovals.concat([{ id: mkId('ap'), toolId }]) })
      return `blocked: "${toolId}" is set to Ask first — the user has been shown an Approve button in the Master chat; wait for their decision, do not retry on your own`
    }
    return null
  }
  // Combine global policy with the target session's per-tool toggle.
  const sessionGate = (sid: string, toolId: string): string | null => {
    const agent = stateRef.current.agents.find(a => a.id === sid)
    const tool = agent?.tools.find(t => t.id === toolId)
    if (!tool) return null
    if (!tool.on || tool.perm === 'Off') return `blocked: the user disabled "${toolId}" for this session`
    if (tool.perm === 'Approval') return `blocked: "${toolId}" for this session is set to Approval — ask the user`
    return null
  }

  const exec: MasterExec = {
    launchSession: (command, cwd, name, terminal) => {
      const gated = catalogGate('launch_session')
      if (gated) return gated
      const terminalShell = terminal ? stateRef.current.settings.shell || 'zsh' : undefined
      const effectiveCommand = terminalShell ? `${terminalShell} -l -i` : command
      const id = ctx.launchSession(effectiveCommand, cwd || '', name || (terminal ? terminalShell : undefined), undefined, undefined, { terminalShell })
      if (!id) return 'failed: empty command'
      ctx.logEvent('route', id, `Master launched · ${effectiveCommand}`)
      ctx.armResponseWatch(id) // relay the session's first output back to Master
      return `launched session id=${id} — its output will be relayed to you as an [event] once it settles; you can also read_session it`
    },
    sendToSession: async (sid, text) => {
      const gated = catalogGate('send_to_session') || sessionGate(sid, 'send')
      if (gated) return gated
      const agent = stateRef.current.agents.find(a => a.id === sid)
      if (!agent) return `no session with id ${sid}`
      ctx.armResponseWatch(sid)
      ;(ctx.sendLine ?? sendLineToSession)(sid, text)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === sid ? { ...a, log: a.log.concat([{ t: 'you', x: `[master] ${text}` }]) } : a),
      }))
      ctx.logEvent('route', sid, `Master → ${agent.name}: ${text.slice(0, 48)}`)
      await wait(1600)
      return `sent to ${agent.name}. screen now:\n${ctx.sessionScreenTail(sid)}`
    },
    pressKeys: async (sid, keys) => {
      const gated = catalogGate('send_to_session') || sessionGate(sid, 'send')
      if (gated) return gated
      const agent = stateRef.current.agents.find(a => a.id === sid)
      if (!agent) return `no session with id ${sid}`
      if (!keys.length) return 'no keys given'
      for (const key of keys.slice(0, 12)) {
        const seq = KEYMAP[key.toLowerCase()] ?? (key.length === 1 ? key : null)
        if (seq === null) return `unknown key "${key}" — use enter/esc/up/down/left/right/tab/space/backspace/ctrl+c or single characters`
        native.writeSession(sid, seq).catch(() => {})
        await wait(160)
      }
      ctx.logEvent('route', sid, `Master pressed ${keys.join(' ')} in ${agent.name}`)
      ctx.armResponseWatch(sid)
      await wait(900)
      return `pressed ${keys.join(' ')}. screen now:\n${ctx.sessionScreenTail(sid)}`
    },
    configureSetting: (key, value) => {
      const gated = catalogGate('configure_setting')
      if (gated) return gated
      const bools = ['autoRoute', 'approveDestructive', 'followMode'] as const
      const strings = ['shell', 'defaultCwd', 'masterModel'] as const
      if ((bools as readonly string[]).includes(key)) {
        const v = value.toLowerCase() === 'true'
        dispatch(s2 => ({ ...s2, settings: { ...s2.settings, [key]: v } }))
        ctx.logEvent('edit', null, `Master set ${key} = ${v}`)
        return `set ${key} = ${v}`
      }
      if ((strings as readonly string[]).includes(key)) {
        if (key === 'shell' && !SHELLS.includes(value)) {
          return `invalid shell "${value}" — use ${SHELLS.join(' | ')}`
        }
        dispatch(s2 => ({ ...s2, settings: { ...s2.settings, [key]: value } }))
        ctx.logEvent('edit', null, `Master set ${key} = ${value}`)
        return `set ${key} = ${value}`
      }
      return `unknown or protected setting: ${key}`
    },
    setToolPermission: (toolId, perm) => {
      const gated = catalogGate('set_tool_permission')
      if (gated) return gated
      if (!(PERM_ORDER as readonly string[]).includes(perm)) return `invalid perm "${perm}" — use Off | Ask first | Auto | Approval`
      const tool = stateRef.current.toolsCatalog.find(t => t.id === toolId)
      if (!tool) return `no tool with id ${toolId}`
      dispatch(s2 => ({
        ...s2,
        toolsCatalog: s2.toolsCatalog.map(t => (t.id === toolId ? { ...t, perm: perm as typeof t.perm } : t)),
      }))
      ctx.logEvent('edit', null, `Master set ${toolId} permission to ${perm}`)
      return `set ${toolId} to ${perm}`
    },
    toggleSchedule: (name, on) => {
      const gated = catalogGate('create_schedule')
      if (gated) return gated
      const cron = stateRef.current.crons.find(c => c.name === name)
      if (!cron) return `no schedule named ${name}`
      dispatch(s2 => ({ ...s2, crons: s2.crons.map(c => (c.name === name ? { ...c, on } : c)) }))
      return `${name} is now ${on ? 'on' : 'off'}`
    },
    deleteSchedule: name => {
      const gated = catalogGate('create_schedule')
      if (gated) return gated
      const cron = stateRef.current.crons.find(c => c.name === name)
      if (!cron) return `no schedule named ${name}`
      dispatch(s2 => ({ ...s2, crons: s2.crons.filter(c => c.name !== name) }))
      ctx.logEvent('cron', null, `Master deleted schedule ${name}`)
      return `deleted ${name}`
    },
    createAddon: (name, icon, html, desc, toolsJson, hooksJson, permissionsJson) => {
      const gated = catalogGate('create_addon')
      if (gated) return gated
      if (!name.trim()) return 'name is required'
      let parsed
      try {
        parsed = parseAddonPackage(JSON.stringify({
          name, icon, html: html || undefined, description: desc,
          tools: toolsJson ? JSON.parse(toolsJson) : undefined,
          hooks: hooksJson ? JSON.parse(hooksJson) : undefined,
          permissions: permissionsJson ? JSON.parse(permissionsJson) : undefined,
          version: '1.0.0',
        }))
      } catch (e) {
        return `invalid addon package: ${e instanceof Error ? e.message : String(e)}`
      }
      const existing = stateRef.current.addons.find(a => a.name === name)
      const addon: Addon = {
        ...parsed,
        id: existing?.id ?? mkId('ad'),
        granted: (existing?.granted ?? parsed.permissions).filter(g => parsed.permissions.includes(g)),
        enabled: true,
        source: 'master',
        createdAt: new Date().toLocaleString(),
      }
      dispatch(s2 => ({
        ...s2,
        addons: existing
          ? s2.addons.map(a => (a.id === existing.id ? addon : a))
          : s2.addons.concat([addon]),
        ...(addon.html ? { view: 'addon' as const, activeAddon: addon.id } : {}),
      }))
      ctx.logEvent('build', null, `Master ${existing ? 'updated' : 'built'} addon “${name}”`)
      ctx.flash(`${existing ? 'Updated' : 'New'} addon · ${name}`)
      const parts = [addon.html ? 'view tab' : '', addon.tools?.length ? `${addon.tools.length} tool(s)` : '', addon.hooks ? 'hooks' : ''].filter(Boolean).join(', ')
      return `${existing ? 'updated' : 'created'} addon "${name}" (${parts})`
    },
    removeAddon: name => {
      const addon = stateRef.current.addons.find(a => a.name === name)
      if (!addon) return `no addon named ${name}`
      ctx.disposeAddon(addon.id)
      dispatch(s2 => {
        const addonStorage = { ...s2.addonStorage }
        delete addonStorage[addon.id]
        const addonChats = { ...s2.addonChats }
        delete addonChats[addon.id]
        return {
          ...s2,
          addons: s2.addons.filter(a => a.id !== addon.id),
          addonStorage, addonChats,
          view: s2.activeAddon === addon.id ? 'workspace' : s2.view,
          activeAddon: s2.activeAddon === addon.id ? null : s2.activeAddon,
        }
      })
      return `removed addon "${name}"`
    },
    runAddonTool: (name, input) => execAddonTool(stateRef.current, name, input, ctx.makeAddonApi),
    updateAgentStatus: (sid, task, summary, actionNeeded) => {
      const agent = stateRef.current.agents.find(a => a.id === sid)
      if (!agent) return `no session with id ${sid}`
      ctx.applyAgentStatus(sid, task, summary, actionNeeded)
      return `updated status for ${agent.name}`
    },
    renameSession: (sid, name) => {
      const agent = stateRef.current.agents.find(a => a.id === sid)
      if (!agent) return `no session with id ${sid}`
      const trimmed = name.trim()
      if (!trimmed) return 'name must not be empty'
      dispatch(s2 => ({
        ...s2,
        agents: s2.agents.map(a => a.id === sid
          ? { ...a, name: trimmed, short: trimmed.slice(0, 2).toUpperCase() }
          : a),
      }))
      ctx.logEvent('edit', sid, `Master renamed session to “${trimmed}”`)
      return `renamed to ${trimmed}`
    },
    flagNeedsInput: (sid, question) => {
      const agent = stateRef.current.agents.find(a => a.id === sid)
      if (!agent) return `no session with id ${sid}`
      ctx.setNeedsInput(sid, question || 'waiting for input')
      return `flagged ${agent.name} as needing user input`
    },
    readSession: (sid, lines) => {
      const agent = stateRef.current.agents.find(a => a.id === sid)
      if (!agent) return `no session with id ${sid}`
      const n = Math.min(Math.max(lines ?? 40, 1), 120)
      const tail = agent.log.slice(-n).map(l => l.x).join('\n')
      return tail || '(no output yet)'
    },
    stopSession: sid => {
      const gated = catalogGate('stop_session') || sessionGate(sid, 'stop')
      if (gated) return gated
      ctx.userStoppedRef.current.add(sid)
      native.killSession(sid).catch(() => {})
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === sid ? { ...a, status: 'idle' as const } : a),
      }))
      return `stopped ${sid}`
    },
    createSchedule: (name, cron, command, cwd, templateName, prompt) => {
      const gated = catalogGate('create_schedule')
      if (gated) return gated
      const tpl = templateName
        ? (stateRef.current.templates ?? []).find(t => t.name.toLowerCase() === templateName.toLowerCase())
        : undefined
      if (templateName && !tpl) return `no template named "${templateName}" — available: ${(stateRef.current.templates ?? []).map(t => t.name).join(', ') || 'none'}`
      dispatch(s => ({
        ...s,
        crons: s.crons.concat([{
          id: mkId('c'), name, schedule: cron, human: humanizeCron(cron),
          target: cwd ? cwd.split('/').pop() || cwd : 'workspace',
          agent: tpl ? tpl.name : command ? command.split(/\s+/)[0] : 'Master',
          color: '#F5C451', on: true, built: true, last: '—', cmd: command, cwd,
          templateId: tpl?.id, prompt,
        }]),
      }))
      ctx.logEvent('cron', null, `Master created schedule ${name}`)
      return `created schedule ${name} (${cron})${tpl ? ` firing template ${tpl.name}` : ''}`
    },
    runTemplate: (templateName, task) => {
      const gated = catalogGate('launch_session')
      if (gated) return gated
      const tpl = (stateRef.current.templates ?? []).find(t => t.name.toLowerCase() === templateName.toLowerCase())
      if (!tpl) return `no template named "${templateName}" — available: ${(stateRef.current.templates ?? []).map(t => t.name).join(', ') || 'none'}`
      const id = ctx.launchFromTemplate(tpl.id, task)
      return id
        ? `launched ${tpl.mode} session ${id} from template ${tpl.name}${tpl.mode === 'ephemeral' ? ' — it will run the task and exit by itself' : ''}`
        : 'launch failed'
    },
    addTask: title => {
      const gated = catalogGate('add_task')
      if (gated) return gated
      dispatch(s => ({
        ...s,
        tasks: s.tasks.concat([{ id: mkId('t'), title, col: 'backlog', agentId: null }]),
      }))
      return `added task "${title}"`
    },
  }

  let pendingTurn: { note?: string } | null = { note: eventNote }
  while (pendingTurn) {
    const note = pendingTurn.note
    pendingTurn = null
    try {
      const { text, thinking } = await runMasterTurn(() => stateRef.current, exec, note, ctx.signal?.())
      if (text || thinking) {
        dispatch(s => ({
          ...s,
          messages: s.messages.concat([{
            id: mkId('m'), role: 'master', kind: 'text',
            text: text || '(acted without a reply)',
            thinking: thinking || undefined,
          }]),
        }))
      }
    } catch (e) {
      // the workspace was deleted mid-turn — stop quietly, don't post an error
      if (isAbortError(e) || ctx.signal?.()?.aborted) { pendingTurn = null; break }
      dispatch(s => ({
        ...s,
        messages: s.messages.concat([{
          id: mkId('m'), role: 'master', kind: 'text',
          text: `Master error: ${e instanceof Error ? e.message : String(e)}`,
        }]),
      }))
    }
    pendingTurn = ctx.masterQueued.current
    ctx.masterQueued.current = null
  }

  ctx.masterBusyRef.current = false
  dispatch(s => ({ ...s, masterBusy: false }))
}
