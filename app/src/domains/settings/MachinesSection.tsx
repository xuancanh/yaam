import { useState } from 'react'
import { useActions, useConductorSelector } from '../../store'
import type { Machine } from '../../core/types'
import { mkId } from '../../shared/id'
import { execCommand } from '../../core/native'
import { testCommand } from '../session/remote-machine'
import { DraftInput } from '../../components/DraftInput'
import { DialogField, DialogFooter, DialogGrid, DialogHeader, EntityDialog } from '../../components/EntityDialog'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { confirmAction } from '../../components/Confirm'

/** Summarize the marker output of `testCommand` into a short human status. */
function summarizeTest(output: string): { ok: boolean; text: string } {
  const has = (m: string) => output.includes(m)
  if (!has('SSH_OK')) return { ok: false, text: output.trim().split('\n').pop()?.slice(0, 140) || 'could not connect' }
  const miss: string[] = []
  if (!has('TMUX_OK')) miss.push('no tmux')
  if (!has('B64_OK')) miss.push('no base64 -d')
  if (!has('GIT_OK')) miss.push('no git')
  if (has('NO_DIR')) miss.push('working dir not found')
  return miss.length ? { ok: false, text: `Connected, but: ${miss.join(', ')}` } : { ok: true, text: 'Connected · tmux, base64, git all present' }
}

/** Spacious popup for one machine: every SSH field + a connection test.
 *  Edits persist through the normal `updateSettings({ machines })` path. */
function MachineDialog({ m, onChange, onRemove, onClose }: {
  m: Machine
  onChange: (patch: Partial<Machine>) => void
  onRemove: () => void
  onClose: () => void
}) {
  const [test, setTest] = useState<{ ok: boolean; text: string } | 'running' | null>(null)
  const runTest = async () => {
    setTest('running')
    try {
      const { output } = await execCommand(testCommand(m), undefined, 15_000)
      setTest(summarizeTest(output))
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }
  const field = (key: keyof Machine, placeholder: string, type?: string) => (
    <DraftInput
      value={m[key] === undefined ? '' : String(m[key])}
      placeholder={placeholder}
      type={type ?? 'text'}
      onCommit={v => {
        const t = v.trim()
        if (key === 'port') onChange({ port: t ? Math.max(1, Math.min(65535, Number(t) || 22)) : undefined })
        else onChange({ [key]: t || undefined } as Partial<Machine>)
      }}
      style={{ ...FIELD_STYLE, width: '100%' }}
    />
  )
  return (
    <EntityDialog onClose={onClose} width={680}>
      <DialogHeader
        onClose={onClose}
        title={<span style={{ fontSize: 15, fontWeight: 600 }}>{m.label || 'Unnamed machine'}</span>}
        sub={<>{m.user && m.host ? `${m.user}@${m.host}${m.port && m.port !== 22 ? `:${m.port}` : ''}` : 'ssh host not set'} · keys / ssh-agent only · changes save on blur</>}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <DialogField label="NAME" hint="shown in the machine picker">
          {field('label', 'e.g. gpu-box')}
        </DialogField>
        <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 90px', gap: 14 }}>
          <DialogField label="USER">{field('user', 'ubuntu')}</DialogField>
          <DialogField label="HOST">{field('host', 'host or IP')}</DialogField>
          <DialogField label="PORT">{field('port', '22', 'number')}</DialogField>
        </div>
        <DialogGrid>
          <DialogField label="IDENTITY FILE" hint="optional — else ssh-agent / default keys">
            {field('identityFile', '~/.ssh/id_ed25519')}
          </DialogField>
          <DialogField label="DEFAULT DIRECTORY" hint="prefilled cwd on the host">
            {field('remoteDir', '/home/ubuntu/project')}
          </DialogField>
        </DialogGrid>
        <DialogField label="EXTRA SSH OPTIONS" hint="advanced, passed verbatim">
          {field('options', 'e.g. -o ProxyJump=bastion')}
        </DialogField>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="open-btn" style={{ flex: 'none', padding: '6px 14px', fontSize: 12 }} disabled={!m.host?.trim() || !m.user?.trim() || test === 'running'} onClick={() => { void runTest() }}>
            {test === 'running' ? 'Testing…' : 'Test connection'}
          </button>
          {test && test !== 'running' && (
            <span style={{ fontSize: 12, color: test.ok ? 'var(--green)' : 'var(--red-soft)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={test.text}>
              {test.ok ? '✓ ' : '✕ '}{test.text}
            </span>
          )}
        </div>
      </div>

      <DialogFooter onClose={onClose}>
        <button
          className="deny-btn"
          style={{ flex: 'none', padding: '8px 16px', color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
          onClick={() => {
            void confirmAction({ title: `Remove machine “${(m.label || m.host || 'machine').slice(0, 40)}”?`, detail: 'Removes this saved SSH host. Running sessions on it are unaffected.' })
              .then(ok => { if (ok) { onRemove(); onClose() } })
          }}
        >
          Remove
        </button>
      </DialogFooter>
    </EntityDialog>
  )
}

/** Settings → Machines: the SSH hosts agents can run on (over tmux).
 *  Compact rows; click one for the full editor popup. */
export function MachinesSection() {
  // default OUTSIDE the selector — a fresh `[]` per snapshot defeats the
  // equality cache (see TaskSpecFields) and loops useSyncExternalStore
  const machines = useConductorSelector(x => x.settings.machines) ?? []
  const { updateSettings } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)
  const setMachines = (next: Machine[]) => updateSettings({ machines: next })
  const open = openId ? machines.find(m => m.id === openId) : undefined
  return (
    <>
      <SectionLabel>REMOTE MACHINES</SectionLabel>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 12, lineHeight: 1.5 }}>
        Run agents on another machine over SSH, inside tmux so they survive disconnects. Pick a machine in the New Session dialog. Auth uses your SSH keys / ssh-agent (no passwords); the agent CLI and <span className="mono">tmux</span> must be installed on the host. Click a machine to configure it.
      </div>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '2px 16px 12px', marginBottom: 16 }}>
        {machines.length === 0 && <div style={{ fontSize: 12, color: 'var(--dim)', padding: '14px 0 6px' }}>No machines yet.</div>}
        {machines.map(m => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: m.host ? 'var(--green)' : 'var(--line3)' }} />
            <div className="palette-item" style={{ flex: 1, minWidth: 0, cursor: 'pointer', borderRadius: 7, padding: '2px 6px', margin: '-2px -6px' }} onClick={() => setOpenId(m.id)} title="Click to view & edit">
              <div style={{ fontSize: 13, fontWeight: 600 }}>{m.label || 'Unnamed machine'}</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.user && m.host ? `${m.user}@${m.host}${m.port && m.port !== 22 ? `:${m.port}` : ''}` : 'ssh host not set'}{m.remoteDir ? ` · ${m.remoteDir}` : ''}
              </div>
            </div>
          </div>
        ))}
        <button
          className="open-btn"
          style={{ marginTop: 12, padding: '7px 14px', fontSize: 12 }}
          onClick={() => {
            const id = mkId('mc')
            setMachines(machines.concat([{ id, label: '', host: '', user: '' }]))
            setOpenId(id)
          }}
        >
          + Add machine
        </button>
      </div>
      {open && (
        <MachineDialog
          m={open}
          onChange={patch => setMachines(machines.map(x => (x.id === open.id ? { ...x, ...patch } : x)))}
          onRemove={() => setMachines(machines.filter(x => x.id !== open.id))}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  )
}
