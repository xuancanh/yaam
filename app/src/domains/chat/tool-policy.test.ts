import { describe, expect, it } from 'vitest'
import { ALWAYS_ASK_TOOLS, toolNeedsApproval } from './agent'

describe('chat tool approval policy', () => {
  it('allows read-only local and web tools without prompting', () => {
    for (const name of ['list_dir', 'read_file', 'grep_files', 'fetch_url', 'list_board_tasks']) {
      expect(toolNeedsApproval(name), name).toBe(false)
    }
  })

  it('gates mutations, process execution, raw HTTP, and MCP tools', () => {
    for (const name of ['write_file', 'edit_file', 'run_command', 'http_request', 'add_board_task', 'save_skill', 'mcp__github__create_issue']) {
      expect(toolNeedsApproval(name), name).toBe(true)
    }
  })

  it('reviews self-modification even in auto mode — the user owns the charter', () => {
    expect(ALWAYS_ASK_TOOLS.has('update_my_profile')).toBe(true)
    // every always-ask tool must also be gated, or the review never triggers
    for (const name of ALWAYS_ASK_TOOLS) expect(toolNeedsApproval(name), name).toBe(true)
  })
})
