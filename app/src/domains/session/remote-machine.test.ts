import { describe, expect, it } from 'vitest'
import { shq, tmuxName, sshPrefix, wrapLaunch, killRemote, findMachine, testCommand } from './remote-machine'
import type { Machine } from '../../core/types'

const m = (over: Partial<Machine> = {}): Machine =>
  ({ id: 'mc1', label: 'box', host: 'example.com', user: 'ubuntu', ...over })

describe('shq', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shq('a b')).toBe(`'a b'`)
    expect(shq(`it's`)).toBe(`'it'\\''s'`)
  })
})

describe('tmuxName', () => {
  it('prefixes and strips characters tmux rejects', () => {
    expect(tmuxName('a_12-3')).toBe('yaam-a_12-3')
    expect(tmuxName('a.b:c')).toBe('yaam-abc')
  })
})

describe('sshPrefix', () => {
  it('interactive opens a tty; batch fails fast', () => {
    expect(sshPrefix(m(), { interactive: true })).toContain('-tt')
    const batch = sshPrefix(m())
    expect(batch).toContain('BatchMode=yes')
    expect(batch).toContain('ConnectTimeout=8')
    expect(batch).not.toContain('-tt')
  })
  it('adds non-default port and identity file, and the target', () => {
    const p = sshPrefix(m({ port: 2222, identityFile: '~/.ssh/k' }), { interactive: true })
    expect(p).toContain('-p 2222')
    expect(p).toContain(`-i '~/.ssh/k'`)
    expect(p.endsWith(`'ubuntu@example.com'`)).toBe(true)
  })
  it('omits port 22 and shares one connection via controlId', () => {
    const p = sshPrefix(m({ port: 22 }), { controlId: 'a1' })
    expect(p).not.toContain('-p 22')
    expect(p).toContain('ControlMaster=auto')
    expect(p).toContain('yaam-a1')
  })
})

describe('wrapLaunch / killRemote', () => {
  it('a plain machine session runs the agent directly over ssh — no tmux', () => {
    const cmd = wrapLaunch(m({ remoteDir: '/srv/app' }), 'claude --model x', 'a1')
    expect(cmd).toContain('ssh -tt')
    expect(cmd).toContain('sh -c')
    expect(cmd).not.toContain('tmux')
    // the inner command is base64-encoded between the two shells; decode it back
    const b64 = cmd.match(/printf %s ([A-Za-z0-9+/=]+) /)?.[1]
    expect(atob(b64!)).toBe(`cd '/srv/app' && claude --model x`)
  })
  it('a detached machine session runs inside an attach-or-create tmux session', () => {
    const cmd = wrapLaunch(m({ remoteDir: '/srv' }), 'claude', 'a1', undefined, true)
    expect(cmd).toContain('ssh -tt')
    expect(cmd).toContain('tmux new-session -A -s yaam-a1')
  })
  it('omits the cd when no remote dir is set', () => {
    const b64 = wrapLaunch(m(), 'htop', 'a1').match(/printf %s ([A-Za-z0-9+/=]+) /)?.[1]
    expect(atob(b64!)).toBe('htop')
  })
  it('uses the session cwd over the machine default (terminal must match Files/Git)', () => {
    const b64 = wrapLaunch(m({ remoteDir: '/def' }), 'claude', 'a1', '/repo-b').match(/printf %s ([A-Za-z0-9+/=]+) /)?.[1]
    expect(atob(b64!)).toBe(`cd '/repo-b' && claude`)
  })
  it('kill targets the same tmux session over batch ssh', () => {
    const k = killRemote(m(), 'a1')
    expect(k).toContain('BatchMode=yes')
    expect(k).toContain(`tmux kill-session -t yaam-a1`)
  })
})

describe('testCommand', () => {
  it('probes reachability, tmux, base64 -d, git, and the working dir over batch ssh', () => {
    const t = testCommand(m({ remoteDir: '/srv' }))
    expect(t).toContain('BatchMode=yes')
    expect(t).toContain('tmux -V')
    expect(t).toContain('base64 -d')
    expect(t).toContain('command -v git')
    expect(t).toContain(`'/srv'`)
  })
})

describe('findMachine', () => {
  it('resolves by id, tolerates undefined', () => {
    const list = [m({ id: 'x' }), m({ id: 'y' })]
    expect(findMachine(list, 'y')?.id).toBe('y')
    expect(findMachine(list, undefined)).toBeUndefined()
    expect(findMachine(undefined, 'x')).toBeUndefined()
  })
})
