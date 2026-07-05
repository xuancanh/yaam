// Credential handling for persistence: which fields are secret, how to redact
// them from the on-disk state, and how to restore them. Secrets live in the OS
// keychain (see domains/secrets.rs); the plaintext state file only keeps
// non-secret data. Redaction is conditional on the secret being confirmed in
// the keychain, so a keychain failure degrades to plaintext rather than losing
// the credential.
import type { AppState, MainPartition } from '../core/types'

export interface SecretEntry {
  /** opaque keychain account id */
  account: string
  /** current in-memory value (may be empty) */
  value: string
}

/** Every credential-bearing field in the state, as keychain entries. */
export function secretEntries(s: AppState): SecretEntry[] {
  const out: SecretEntry[] = [
    { account: 'master.apiKey', value: s.settings.apiKey ?? '' },
    { account: 'github.token', value: s.settings.githubToken ?? '' },
  ]
  for (const t of s.chatAgentTypes ?? []) out.push({ account: `chat.${t.id}.apiKey`, value: t.apiKey ?? '' })
  for (const m of s.mcpServers ?? []) out.push({ account: `mcp.${m.id}.headers`, value: m.headers ?? '' })
  return out
}

/** Blank the secret fields whose account is confirmed in the keychain, so the
 *  plaintext file never holds a credential we've safely stored elsewhere. */
export function redactSecrets(main: MainPartition, keychainReady: Set<string>): MainPartition {
  const red = { ...main }
  if (keychainReady.has('master.apiKey') && red.settings) {
    red.settings = { ...red.settings, apiKey: '' }
  }
  if (keychainReady.has('github.token') && red.settings) {
    red.settings = { ...red.settings, githubToken: '' }
  }
  if (red.chatAgentTypes) {
    red.chatAgentTypes = red.chatAgentTypes.map(t =>
      keychainReady.has(`chat.${t.id}.apiKey`) ? { ...t, apiKey: '' } : t)
  }
  if (red.mcpServers) {
    red.mcpServers = red.mcpServers.map(m =>
      keychainReady.has(`mcp.${m.id}.headers`) ? { ...m, headers: '' } : m)
  }
  return red
}

/** Apply resolved keychain values back onto state (only where currently empty,
 *  so legacy plaintext still present in the loaded file is never overwritten). */
export function applyResolvedSecrets(s: AppState, resolved: Record<string, string>): AppState {
  const next = { ...s }
  const master = resolved['master.apiKey']
  if (master && !next.settings.apiKey) next.settings = { ...next.settings, apiKey: master }
  const gh = resolved['github.token']
  if (gh && !next.settings.githubToken) next.settings = { ...next.settings, githubToken: gh }
  next.chatAgentTypes = (next.chatAgentTypes ?? []).map(t => {
    const v = resolved[`chat.${t.id}.apiKey`]
    return v && !t.apiKey ? { ...t, apiKey: v } : t
  })
  next.mcpServers = (next.mcpServers ?? []).map(m => {
    const v = resolved[`mcp.${m.id}.headers`]
    return v && !m.headers ? { ...m, headers: v } : m
  })
  return next
}
