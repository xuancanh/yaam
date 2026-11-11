// Parsing and matching for an addon's `contributes` block (panel, commands,
// link handlers). Pure: shared by the package parser, the palette, the key
// handler and the terminal link router.
import type { AddonAction, AddonCommand, AddonContributes, AddonLinkHandler } from './entities'

const MAX_COMMANDS = 12
const MAX_LINKS = 8
const MAX_PATTERN = 300
/** longest URL a link handler regex is ever run against (bounds regex cost) */
export const MAX_LINK_URL = 2048

/** Shortcuts the app already owns; an addon cannot take them. */
const RESERVED_KEYS = new Set([
  'mod+k', 'mod+t', 'mod+n', 'mod+b', 'mod+j', 'mod+,', 'mod+=', 'mod+-', 'mod+0', 'mod+p', 'mod+f', 'mod+s', 'mod+w', 'mod+q',
  'mod+shift+a', 'mod+shift+]', 'mod+shift+[',
  ...Array.from({ length: 9 }, (_, i) => `mod+${i + 1}`),
])

/** Normalize "Mod+Alt+G" → "mod+alt+g" (modifier order fixed). Null when the
 *  combo has no mod key, no extra modifier, or is reserved by the app. */
export function normalizeKey(key: string): string | null {
  const parts = key.toLowerCase().split('+').map(p => p.trim()).filter(Boolean)
  const main = parts.pop()
  if (!main || main.length !== 1) return null
  const mods = new Set(parts.map(p => (p === 'cmd' || p === 'ctrl' || p === 'meta' ? 'mod' : p === 'option' ? 'alt' : p)))
  if (!mods.has('mod') || [...mods].some(m => !['mod', 'alt', 'shift'].includes(m))) return null
  // a bare mod+<key> collides too easily with the app and the CLIs it hosts
  if (!mods.has('alt') && !mods.has('shift')) return null
  const out = ['mod', ...(mods.has('alt') ? ['alt'] : []), ...(mods.has('shift') ? ['shift'] : []), main].join('+')
  return RESERVED_KEYS.has(out) ? null : out
}

/** Display form of a normalized combo: "mod+alt+g" → "⌘⌥G" on macOS. */
export function keyLabel(key: string, mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)): string {
  return key.split('+').map(p => p === 'mod' ? (mac ? '⌘' : 'Ctrl+') : p === 'alt' ? (mac ? '⌥' : 'Alt+') : p === 'shift' ? (mac ? '⇧' : 'Shift+') : p.toUpperCase()).join('')
}

/** The normalized combo of a keyboard event (same shape as normalizeKey). */
export function eventKey(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>, mac: boolean): string | null {
  if (!(mac ? e.metaKey : e.ctrlKey)) return null
  // with ⌥ held, macOS turns e.key into a symbol (⌥G = ©); read the physical key
  const fromCode = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1]
  const main = (fromCode ?? e.key).toLowerCase()
  if (main.length !== 1) return null
  return ['mod', ...(e.altKey ? ['alt'] : []), ...(e.shiftKey ? ['shift'] : []), main].join('+')
}

function parseAction(o: Record<string, unknown>, toolNames: Set<string>, hasView: boolean, where: string): AddonAction {
  const run = typeof o.run === 'string' ? o.run.trim() : undefined
  if (run && !toolNames.has(run)) throw new Error(`${where}: run "${run}" is not one of this addon's tools`)
  const open = o.open === 'popup' || o.open === 'panel' || o.open === 'tab' ? o.open : undefined
  if (o.open !== undefined && !open) throw new Error(`${where}: open must be popup, panel or tab`)
  if (open && !hasView) throw new Error(`${where}: open needs the addon to have a view`)
  if (!run && !open) throw new Error(`${where}: needs run (a tool) or open (popup | panel | tab)`)
  return { ...(run ? { run } : {}), ...(open ? { open } : {}) }
}

/** Validate a raw `contributes` block. Throws with a precise message so the
 *  author sees it at install/build time instead of a silently missing entry. */
export function parseContributes(raw: unknown, opts: { toolNames: string[]; hasView: boolean }): AddonContributes | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('contributes must be a map')
  const r = raw as Record<string, unknown>
  const tools = new Set(opts.toolNames)
  const out: AddonContributes = {}

  if (r.panel !== undefined) {
    if (!opts.hasView) throw new Error('contributes.panel needs the addon to have a view')
    const p = (r.panel ?? {}) as Record<string, unknown>
    const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 40) : ''
    if (!title) throw new Error('contributes.panel needs a title')
    out.panel = { title }
  }

  if (r.commands !== undefined) {
    if (!Array.isArray(r.commands)) throw new Error('contributes.commands must be a list')
    if (r.commands.length > MAX_COMMANDS) throw new Error(`contributes.commands: at most ${MAX_COMMANDS}`)
    const ids = new Set<string>()
    out.commands = r.commands.map((c, i): AddonCommand => {
      const o = (c ?? {}) as Record<string, unknown>
      const where = `contributes.commands[${i}]`
      const id = typeof o.id === 'string' ? o.id.trim().replace(/[^a-z0-9_.-]/gi, '_').slice(0, 40) : ''
      const title = typeof o.title === 'string' ? o.title.trim().slice(0, 80) : ''
      if (!id || !title) throw new Error(`${where}: needs id and title`)
      if (ids.has(id)) throw new Error(`${where}: duplicate id "${id}"`)
      ids.add(id)
      let key: string | undefined
      if (o.key !== undefined) {
        key = typeof o.key === 'string' ? normalizeKey(o.key) ?? undefined : undefined
        if (!key) throw new Error(`${where}: key "${String(o.key)}" must be mod+alt+<key> or mod+shift+<key> and not one the app uses`)
      }
      const context = o.context === 'session' ? 'session' as const : undefined
      return { id, title, ...parseAction(o, tools, opts.hasView, where), ...(key ? { key } : {}), ...(context ? { context } : {}) }
    })
  }

  if (r.links !== undefined) {
    if (!Array.isArray(r.links)) throw new Error('contributes.links must be a list')
    if (r.links.length > MAX_LINKS) throw new Error(`contributes.links: at most ${MAX_LINKS}`)
    out.links = r.links.map((l, i): AddonLinkHandler => {
      const o = (l ?? {}) as Record<string, unknown>
      const where = `contributes.links[${i}]`
      const pattern = typeof o.pattern === 'string' ? o.pattern : ''
      if (!pattern || pattern.length > MAX_PATTERN) throw new Error(`${where}: pattern must be a regex up to ${MAX_PATTERN} chars`)
      try { new RegExp(pattern) } catch (e) { throw new Error(`${where}: bad pattern: ${e instanceof Error ? e.message : String(e)}`) }
      if (o.open === 'tab') throw new Error(`${where}: open must be popup or panel`)
      return { pattern, ...parseAction(o, tools, opts.hasView, where) }
    })
  }

  return out.panel || out.commands?.length || out.links?.length ? out : undefined
}

/** First matching link handler across addons, in install order. */
export function matchLink<T extends { id: string; contributes?: AddonContributes }>(addons: T[], url: string): { addon: T; handler: AddonLinkHandler } | null {
  if (url.length > MAX_LINK_URL) return null
  for (const addon of addons) {
    for (const handler of addon.contributes?.links ?? []) {
      try { if (new RegExp(handler.pattern).test(url)) return { addon, handler } } catch { /* validated at install */ }
    }
  }
  return null
}
