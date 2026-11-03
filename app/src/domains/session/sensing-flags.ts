// Structured-sensing launch flags for a LOCAL session: per-session hook
// settings, YAAM's manager MCP server, the Kiro file-hook bridge, and a pinned
// OpenCode event-server port. Shared by launch and resume: a resumed CLI is a
// new process, so without re-applying these it would run blind (no hooks, no
// session-id tracking) for the rest of its life.
import { shQuote } from '../../core/agent-adapters'
import type { AgentAdapter } from '../../core/agent-adapters'
import type { SessionProcessPort } from './ports'

type SensingPort = Pick<SessionProcessPort, 'hooksInfo' | 'installKiroHooks' | 'freePort' | 'watchOpencode'>

/** Append the adapter's sensing flags to `command`. Callers must only use this
 *  for local, non-terminal sessions (a remote host can't reach loopback).
 *  Best-effort: an unavailable listener leaves the command unchanged. */
export async function withSensingFlags(port: SensingPort, id: string, command: string, adapter: AgentAdapter | undefined): Promise<string> {
  if (!adapter) return command
  let launchCommand = command
  // per-session settings pointing lifecycle hooks at YAAM's loopback listener;
  // a user-supplied --settings wins over ours. Purely additive: an unreachable
  // listener makes the hook fail fast and the CLI proceeds.
  if (adapter.hookSettings && !/(^|\s)--settings(\s|=)/.test(command)) {
    const info = await port.hooksInfo().catch(() => null)
    if (info) {
      const url = `http://127.0.0.1:${info.port}/hook?token=${encodeURIComponent(info.token)}&agent=${encodeURIComponent(id)}`
      launchCommand = `${launchCommand} --settings ${shQuote(adapter.hookSettings(url))}`
    }
  }
  // manager MCP server: the session gets report_status/get_task tools pointed
  // at the same loopback listener (its /mcp route)
  if (adapter.mcpConfigFlag && !/--strict-mcp-config/.test(command)) {
    const info = await port.hooksInfo().catch(() => null)
    if (info) {
      const url = `http://127.0.0.1:${info.port}/mcp?token=${encodeURIComponent(info.token)}&agent=${encodeURIComponent(id)}`
      launchCommand = `${launchCommand} ${adapter.mcpConfigFlag(url)}`
    }
  }
  // file-hook CLIs (kiro): refresh the global hook bridge with this run's
  // listener address and export the session id so events map exactly
  if (adapter.fileHooks === 'kiro') {
    const info = await port.hooksInfo().catch(() => null)
    if (info) {
      void port.installKiroHooks(`http://127.0.0.1:${info.port}/hook?token=${encodeURIComponent(info.token)}`)
      if (adapter.sessionEnv) launchCommand = `${adapter.sessionEnv(id)} ${launchCommand}`
    }
  }
  // event-server CLIs (opencode): pin the server to a port we allocated and
  // stream its SSE bus (status, permissions, and the session id its SQLite
  // store hides from file detection)
  if (adapter.serverPortFlag && !/(^|\s)--port(\s|=)/.test(command)) {
    const serverPort = await port.freePort().catch(() => null)
    if (serverPort) {
      launchCommand = `${launchCommand} ${adapter.serverPortFlag(serverPort)}`
      void port.watchOpencode(id, serverPort)
    }
  }
  return launchCommand
}
