import { describe, expect, it } from 'vitest'
import { sandboxLocalWrap, sandboxRemoteWrap } from './sandbox'

describe('sandboxLocalWrap', () => {
  it('runs the command through /bin/sh under the backend wrapper, quoted as one argument', () => {
    expect(sandboxLocalWrap("sandbox-exec -f '/p.sb'", 'FOO=1 claude --session-id u'))
      .toBe("sandbox-exec -f '/p.sb' /bin/sh -c 'FOO=1 claude --session-id u'")
  })

  it('escapes single quotes so the command cannot break out of the inner sh', () => {
    expect(sandboxLocalWrap('bwrap --ro-bind / /', "echo 'hi'"))
      .toBe(`bwrap --ro-bind / / /bin/sh -c 'echo '\\''hi'\\'''`)
  })
})

describe('sandboxRemoteWrap', () => {
  const wrap = sandboxRemoteWrap('claude -p "task"', '/home/u/proj', {})

  it('fails closed when bwrap is missing on the host', () => {
    expect(wrap).toContain('command -v bwrap >/dev/null 2>&1 || { echo "yaam: sandbox requested but bwrap is not installed')
    expect(wrap).toContain('exit 97')
  })

  it('read-only-binds the root, write-binds the cwd/tmp, and dies with the session', () => {
    expect(wrap).toContain('exec bwrap --ro-bind / / --dev /dev --unshare-pid --unshare-ipc --proc /proc --die-with-parent')
    expect(wrap).toContain("--bind '/home/u/proj' '/home/u/proj'")
    expect(wrap).toContain("--bind '/tmp' '/tmp'")
    expect(wrap).toContain(`sh -c 'claude -p "task"'`)
  })

  it('write-binds the agent config dot-dirs, expanded by the remote shell', () => {
    expect(wrap).toContain('--bind-try "$HOME/.claude" "$HOME/.claude"')
    expect(wrap).toContain('--bind-try "$HOME/.codex" "$HOME/.codex"')
    expect(wrap).toContain('--bind-try "$HOME/.gemini" "$HOME/.gemini"')
    expect(wrap).not.toContain('$HOME/.config')
    expect(wrap).not.toContain('$HOME/.local')
    expect(wrap).not.toContain('$HOME/.yaam')
    expect(wrap).toContain('if [ -L "$HOME/.claude" ]')
    expect(wrap).toContain('agent state path is a symlink')
  })

  it('masks privileged container-engine sockets after writable binds', () => {
    expect(wrap).toContain('--ro-bind-try /dev/null /var/run/docker.sock')
    expect(wrap).toContain('--ro-bind-try /dev/null "$HOME/.docker/run/docker.sock"')
    expect(wrap.indexOf('--ro-bind-try /dev/null /var/run/docker.sock')).toBeGreaterThan(wrap.indexOf("--bind '/home/u/proj'"))
  })

  it('unshares the network only when denyNetwork is set', () => {
    expect(wrap).not.toContain('--unshare-net')
    expect(sandboxRemoteWrap('x', '/d', { denyNetwork: true })).toContain('--unshare-net sh -c')
  })

  it('binds extra writable paths and skips a missing cwd', () => {
    const w = sandboxRemoteWrap('x', undefined, { extraPaths: ['/data/out', ' '] })
    expect(w).toContain("--bind '/data/out' '/data/out'")
    expect(w).not.toContain("--bind '' ''")
    expect(w).not.toContain("--bind ' ' ' '")
  })

  it('expands remote home paths without treating the tilde literally', () => {
    const w = sandboxRemoteWrap('x', '~/project', { extraPaths: ['~/output'] })
    expect(w).toContain('--bind "$HOME"/\'project\' "$HOME"/\'project\'')
    expect(w).toContain('--bind "$HOME"/\'output\' "$HOME"/\'output\'')
    expect(w).not.toContain("'~/project'")
  })

  it('rejects relative, control-character, and excessive path policies', () => {
    expect(() => sandboxRemoteWrap('x', 'relative', {})).toThrow(/absolute path/)
    expect(() => sandboxRemoteWrap('x', '/repo\n--bind / /', {})).toThrow(/control characters/)
    expect(() => sandboxRemoteWrap('x', '/repo', { extraPaths: Array.from({ length: 33 }, () => '/tmp') })).toThrow(/at most 32/)
  })
})
