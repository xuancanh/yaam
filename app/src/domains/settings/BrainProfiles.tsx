import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { hexToRgba, ACCENT } from '../../core/data'
import type { BrainProfile, OrchestrationSettings } from '../../core/types'
import { providerFor } from '../../master'
import { mkId } from '../../shared/id'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { confirmAction } from '../../components/Confirm'

/** The settings fields a Brain profile snapshots. */
const BRAIN_KEYS = ['provider', 'masterModel', 'monitorModel', 'apiKey', 'baseUrl', 'awsRegion', 'awsProfile', 'awsRefreshCmd', 'credCmd'] as const

/** Capture the current Master Brain fields from settings. */
function snapshot(s: OrchestrationSettings): Omit<BrainProfile, 'id' | 'name'> {
  return {
    provider: s.provider, masterModel: s.masterModel, monitorModel: s.monitorModel,
    apiKey: s.apiKey, baseUrl: s.baseUrl, awsRegion: s.awsRegion,
    awsProfile: s.awsProfile, awsRefreshCmd: s.awsRefreshCmd, credCmd: s.credCmd,
  }
}

/** Saved Master Brain setups: apply one to switch provider/model/credentials
 *  in one click, save the current fields as a new profile, or sync edits back
 *  into the applied one. Rendered above the Brain fields in Settings. */
export function BrainProfilesBar() {
  const s = useConductorSelector(x => ({ settings: x.settings }), shallowEqual)
  const { updateSettings } = useActions()
  const [name, setName] = useState('')
  const profiles = s.settings.brainProfiles ?? []
  const active = profiles.find(p => p.id === s.settings.brainProfileId)
  // the applied profile no longer matches the live fields → offer to save back
  const dirty = !!active && BRAIN_KEYS.some(k => (active[k] ?? '') !== (s.settings[k] ?? ''))

  const apply = (p: BrainProfile) => {
    const { id: _id, name: _name, ...fields } = p
    updateSettings({ ...fields, brainProfileId: p.id })
  }
  const saveNew = () => {
    const p: BrainProfile = {
      id: mkId('bp'),
      name: name.trim() || `${providerFor(s.settings.provider).label} · ${s.settings.masterModel || 'default'}`,
      ...snapshot(s.settings),
    }
    updateSettings({ brainProfiles: profiles.concat([p]), brainProfileId: p.id })
    setName('')
  }
  const remove = (p: BrainProfile) => {
    void confirmAction({
      title: `Delete profile “${p.name.slice(0, 40)}”?`,
      detail: 'The saved provider/model/credential snapshot is removed. Your live Master Brain settings are unchanged.',
    }).then(ok => {
      if (!ok) return
      updateSettings({
        brainProfiles: profiles.filter(x => x.id !== p.id),
        ...(s.settings.brainProfileId === p.id ? { brainProfileId: undefined } : {}),
      })
    })
  }

  return (
    <>
      <SectionLabel>PROFILES — saved provider/model/credential setups; click one to switch</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '13px 16px', marginBottom: 26 }}>
        {profiles.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {profiles.map(p => {
              const isActive = p.id === active?.id
              return (
                <span
                  key={p.id}
                  className="mono"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 6px 5px 12px',
                    borderRadius: 99, fontSize: 11.5, cursor: 'pointer',
                    background: isActive ? hexToRgba(ACCENT, 0.14) : 'var(--bg2)',
                    border: `1px solid ${isActive ? hexToRgba(ACCENT, 0.5) : 'var(--line2)'}`,
                    color: isActive ? 'var(--accent)' : 'var(--text2)',
                  }}
                  title={`${providerFor(p.provider).label} · ${p.masterModel || 'default model'}${isActive ? dirty ? ' · applied, edited since' : ' · applied' : ' — click to apply'}`}
                  onClick={() => apply(p)}
                >
                  {p.name}
                  {isActive && <span style={{ fontSize: 9, fontWeight: 700 }}>{dirty ? 'EDITED' : 'ACTIVE'}</span>}
                  <button
                    title="Delete profile"
                    onClick={e => { e.stopPropagation(); remove(p) }}
                    style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 12, padding: '0 4px', lineHeight: 1 }}
                  >
                    ✕
                  </button>
                </span>
              )
            })}
          </div>
        )}
        {profiles.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 12, lineHeight: 1.5 }}>
            No profiles yet — configure the fields below, then save them as a profile to switch setups (work vs personal key, different providers, a cheap-model profile…) without retyping.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveNew() }}
            placeholder={`profile name · e.g. ${providerFor(s.settings.provider).label.toLowerCase()}-main`}
            style={{ ...FIELD_STYLE, flex: 1, maxWidth: 320 }}
          />
          <button className="open-btn" style={{ flex: 'none', padding: '6px 14px', fontSize: 12 }} onClick={saveNew}>
            Save current as profile
          </button>
          {active && dirty && (
            <button
              className="open-btn"
              style={{ flex: 'none', padding: '6px 14px', fontSize: 12, color: 'var(--accent)' }}
              title="The fields below changed since this profile was applied — write the current values back into it"
              onClick={() => updateSettings({
                brainProfiles: profiles.map(x => (x.id === active.id ? { ...x, ...snapshot(s.settings) } : x)),
              })}
            >
              Update “{active.name.slice(0, 24)}”
            </button>
          )}
        </div>
      </div>
    </>
  )
}
