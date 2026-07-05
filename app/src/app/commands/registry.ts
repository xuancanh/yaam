// The command registry: one place every actor calls to run a use case. It
// validates input, asks the policy for an allow/ask/deny verdict, consumes a
// one-shot approval for 'ask', records an audit entry, then runs the handler.
import type { Actor, CommandContext, CommandDef, Policy } from './types'
import { CommandDenied, approvalKey } from './types'

export interface AuditEntry {
  command: string
  actor: Actor
  decision: 'allow' | 'ask-approved' | 'deny'
  at: number
  error?: string
}

export interface CommandRegistry {
  register: <I, R>(command: CommandDef<I, R>) => void
  /** run a registered command as `actor`; throws CommandDenied if policy blocks it */
  execute: <R = unknown>(name: string, input: unknown, ctx: CommandContext) => Promise<R>
  has: (name: string) => boolean
  /** most recent audit entries (bounded), newest last */
  readonly audit: readonly AuditEntry[]
}

export interface RegistryOptions {
  /** sink for audit entries (defaults to a bounded in-memory ring) */
  onAudit?: (entry: AuditEntry) => void
}

const AUDIT_CAP = 200

export function createCommandRegistry(policy: Policy, opts: RegistryOptions = {}): CommandRegistry {
  const commands = new Map<string, CommandDef>()
  const audit: AuditEntry[] = []
  const record = (entry: AuditEntry) => {
    audit.push(entry)
    if (audit.length > AUDIT_CAP) audit.splice(0, audit.length - AUDIT_CAP)
    opts.onAudit?.(entry)
  }

  return {
    register(command) { commands.set(command.name, command as CommandDef) },
    has: name => commands.has(name),
    get audit() { return audit },
    async execute<R = unknown>(name: string, input: unknown, ctx: CommandContext): Promise<R> {
      const command = commands.get(name)
      if (!command) throw new CommandDenied(name, 'ui', `unknown command "${name}"`)
      command.validate?.(input)

      const decision = policy(ctx.actor, command, input)
      if (decision === 'deny') {
        record({ command: name, actor: ctx.actor, decision: 'deny', at: Date.now() })
        throw new CommandDenied(name, command.capability, `capability "${command.capability}" is not permitted for this actor`)
      }
      if (decision === 'ask') {
        const key = approvalKey(ctx.actor, name)
        if (!ctx.approvals?.delete(key)) {
          record({ command: name, actor: ctx.actor, decision: 'deny', at: Date.now(), error: 'awaiting approval' })
          throw new CommandDenied(name, command.capability, `"${name}" requires user approval`)
        }
      }
      record({ command: name, actor: ctx.actor, decision: decision === 'ask' ? 'ask-approved' : 'allow', at: Date.now() })
      return await command.handler(input, ctx) as R
    },
  }
}
