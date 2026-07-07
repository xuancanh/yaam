import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import type { Machine } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { mkId } from '../../shared/id'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { confirmAction } from '../../components/Confirm'

/** One saved machine: summary row + expandable editor. Edits persist through the
 *  normal `updateSettings({ machines })` path, like the MCP/registry lists. */
function MachineRow({ m, onChange, onRemove }: { m: Machine; onChange: (patch: Partial<Machine>) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(!m.host)
  const field = (label: string, key: keyof Machine, placeholder: string, opts: { type?: string; width?: number } = {}) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: opts.width ? `0 0 ${opts.width}px` : 1, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--mut)' }}>{label}</span>
      <input
        defaultValue={m[key] === undefined ? '' : String(m[key])}
        placeholder={placeholder}
        type={opts.type ?? 'text'}
        onBlur={e => {
          const v = e.target.value.trim()
          if (key === 'port') onChange({ port: v ? Math.max(1, Math.min(65535, Number(v) || 22)) : undefined })
          else onChange({ [key]: v || undefined } as Partial<Machine>)
        }}
        style={{ ...FIELD_STYLE, fontSize: 11.5 }}
      />
    </label>
  )
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: m.host ? 'var(--green)' : 'var(--line3)' }} />
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpen(v => !v)} title="Click to edit">
          <div style={{ fontSize: 13, fontWeight: 600 }}>{m.label || 'Unnamed machine'}</div>
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {m.user && m.host ? `${m.user}@${m.host}${m.port && m.port !== 22 ? `:${m.port}` : ''}` : 'ssh host not set'}{m.remoteDir ? ` · ${m.remoteDir}` : ''}
          </div>
        </div>
        <button className="icon-btn danger" title="Remove machine" style={{ width: 26, height: 26 }} onClick={() => { void confirmAction({ title: `Remove machine “${(m.label || m.host || 'machine').slice(0, 40)}”?`, detail: 'Removes this saved SSH host. Running sessions on it are unaffected.' }).then(ok => { if (ok) onRemove() }) }}>
          <Icon paths={IC.close} size={12} stroke={2} />
        </button>
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0 2px 20px' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {field('Name', 'label', 'e.g. gpu-box')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {field('User', 'user', 'ubuntu', { width: 130 })}
            {field('Host', 'host', 'host or IP')}
            {field('Port', 'port', '22', { type: 'number', width: 80 })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {field('Identity file', 'identityFile', '~/.ssh/id_ed25519 (optional — else ssh-agent)')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {field('Default dir', 'remoteDir', '/home/ubuntu/project (optional)')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {field('Extra ssh options', 'options', 'advanced, e.g. -o ProxyJump=bastion')}
          </div>
        </div>
      )}
    </div>
  )
}

/** Settings → Machines: manage the SSH hosts agents can run on (over tmux). */
export function MachinesSection() {
  const machines = useConductorSelector(x => x.settings.machines ?? [], shallowEqual)
  const { updateSettings } = useActions()
  const setMachines = (next: Machine[]) => updateSettings({ machines: next })
  return (
    <>
      <SectionLabel>REMOTE MACHINES</SectionLabel>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 12, lineHeight: 1.5 }}>
        Run agents on another machine over SSH, inside tmux so they survive disconnects. Pick a machine in the New Session dialog. Auth uses your SSH keys / ssh-agent (no passwords); the agent CLI and <span className="mono">tmux</span> must be installed on the host.
      </div>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '2px 16px 12px', marginBottom: 16 }}>
        {machines.length === 0 && <div style={{ fontSize: 12, color: 'var(--dim)', padding: '14px 0 6px' }}>No machines yet.</div>}
        {machines.map(m => (
          <MachineRow
            key={m.id}
            m={m}
            onChange={patch => setMachines(machines.map(x => (x.id === m.id ? { ...x, ...patch } : x)))}
            onRemove={() => setMachines(machines.filter(x => x.id !== m.id))}
          />
        ))}
        <button
          className="open-btn"
          style={{ marginTop: 12, padding: '7px 14px', fontSize: 12 }}
          onClick={() => setMachines(machines.concat([{ id: mkId('mc'), label: '', host: '', user: '' }]))}
        >
          + Add machine
        </button>
      </div>
    </>
  )
}
