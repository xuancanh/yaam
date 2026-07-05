// Application command layer. Every actor — the UI, Master, a task watcher, a
// chat agent, an addon — reaches domain behavior through one command registry
// with one authorization policy, instead of each caller re-implementing the same
// use case with its own validation and permission checks. A command owns a stable
// name, a required capability, input validation, and a handler; the policy maps
// (actor, command, input) → allow | ask | deny before the handler ever runs.
import type { AddonPermission } from '../../core/types'

/** Who is invoking a command — carried through so policy + audit can distinguish
 *  a user action from Master, a task watcher, a chat agent, or an addon. */
export type Actor =
  | { kind: 'user' }
  | { kind: 'master' }
  | { kind: 'watcher'; taskId: string }
  | { kind: 'chat'; sessionId: string }
  | { kind: 'addon'; addonId: string }

/** Capabilities gate commands. Addon capabilities reuse the addon permission
 *  scopes so one policy governs both addon RPC and every other caller. */
export type Capability = AddonPermission

/** The policy's verdict for one (actor, command, input) triple. */
export type PolicyDecision = 'allow' | 'ask' | 'deny'

export interface CommandContext {
  actor: Actor
  /** one-shot approvals the user already granted (consumed by 'ask' commands) */
  approvals?: Set<string>
}

/** A registered application command. `I` is its input, `R` its result. */
export interface CommandDef<I = unknown, R = unknown> {
  name: string
  /** capability this command requires (policy + addon permission map key) */
  capability: Capability
  /** throw with a readable message on invalid input (before policy/handler) */
  validate?: (input: I) => void
  /** perform the command; only runs after validation + an allow/consumed-ask */
  handler: (input: I, ctx: CommandContext) => R | Promise<R>
}

/** Decides whether an actor may run a command with the given input. */
export type Policy = (actor: Actor, command: CommandDef, input: unknown) => PolicyDecision

/** Raised when policy denies a command (or an 'ask' wasn't pre-approved). */
export class CommandDenied extends Error {
  readonly command: string
  readonly capability: Capability
  constructor(command: string, capability: Capability, reason: string) {
    super(reason)
    this.name = 'CommandDenied'
    this.command = command
    this.capability = capability
  }
}

/** A stable key for a one-shot approval of (actor, command). */
export function approvalKey(actor: Actor, command: string): string {
  const who = actor.kind === 'addon' ? `addon:${actor.addonId}`
    : actor.kind === 'watcher' ? `watcher:${actor.taskId}`
    : actor.kind === 'chat' ? `chat:${actor.sessionId}`
    : actor.kind
  return `${who}/${command}`
}
