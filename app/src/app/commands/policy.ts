// The default authorization policy. Addons are untrusted: a command is allowed
// only if the addon was granted the command's capability (mirroring the addon
// permission model, so addon RPC and every other route share one gate). The UI
// and the trusted orchestration actors (Master, task watchers, chat agents) are
// allowed at this layer — their own per-action gates (Master tool permissions,
// chat ask/auto mode, UI confirmations) apply where those flows live.
import type { AddonPermission } from '../../core/types'
import type { Policy } from './types'

export function createDefaultPolicy(getAddonGrants: (addonId: string) => AddonPermission[]): Policy {
  return (actor, command) => {
    switch (actor.kind) {
      case 'user':
      case 'master':
      case 'watcher':
      case 'chat':
        return 'allow'
      case 'addon':
        return getAddonGrants(actor.addonId).includes(command.capability) ? 'allow' : 'deny'
    }
  }
}
