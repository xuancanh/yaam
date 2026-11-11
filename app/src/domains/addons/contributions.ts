// Runs an addon contribution (palette command, shortcut, session menu item,
// terminal link handler). Contributions are UI entry points, so they need the
// addon enabled with the `ui` grant; a `run` tool still goes through the
// addon's normal permission-enforced API.
import type { Addon, AddonAction, AddonCommand, AddonViewContext } from '../../core/entities'
import type { AppState } from '../../core/types'
import { openAddonPanel, openAddonPopup } from './addon-ui-bus'

export interface ContributionDeps {
  runAddonTool: (addonId: string, tool: string, input: Record<string, unknown>) => Promise<string>
  openAddonTab: (addonId: string) => void
  flash: (text: string) => void
}

/** Addons whose contributions are live. */
export function activeContributors(s: Pick<AppState, 'addons'>): Addon[] {
  return (s.addons ?? []).filter(a => a.enabled && a.granted.includes('ui') && a.contributes)
}

/** Every contributed command, for the palette and the key handler. */
export function contributedCommands(s: Pick<AppState, 'addons'>): { addon: Addon; command: AddonCommand }[] {
  return activeContributors(s).flatMap(addon => (addon.contributes?.commands ?? []).map(command => ({ addon, command })))
}

/** Addons that can dock a panel in a session pane. */
export function panelAddons(s: Pick<AppState, 'addons'>): Addon[] {
  return activeContributors(s).filter(a => a.contributes?.panel && a.html)
}

/** Perform `action` for `addon` with `context` (session, url, selection...). */
export async function runContribution(deps: ContributionDeps, addon: Addon, action: AddonAction, context: Omit<AddonViewContext, 'placement'>): Promise<void> {
  if (!addon.enabled || !addon.granted.includes('ui')) {
    deps.flash(`${addon.name}: enable the addon and its "ui" permission to use this`)
    return
  }
  if (action.open === 'panel' && addon.html) {
    // a panel needs a session pane; without one (or with none mounted) use a popup
    if (!context.sessionId || !openAddonPanel(context.sessionId, addon.id, context)) openAddonPopup(addon.id, context)
  } else if (action.open === 'popup' && addon.html) {
    openAddonPopup(addon.id, context)
  } else if (action.open === 'tab') {
    deps.openAddonTab(addon.id)
  }
  if (action.run) {
    const out = await deps.runAddonTool(addon.id, action.run, { ...context })
    if (out && out !== 'ok' && out !== '"ok"') deps.flash(`${addon.icon} ${out.length > 240 ? `${out.slice(0, 240)}…` : out}`)
  }
}
