// Monitor/watcher LLM rows of the Master Brain panel. Monitors can run on a
// local OpenAI-compatible server (Ollama, LM Studio, llama-server) while Master
// stays on the remote provider: they fire on every settle, so a small local
// model removes most of the per-session API traffic.
import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { providerFor } from '../../master'
import { listServerModels, openAiBase } from '../../llm/client'
import { DraftInput } from '../../components/DraftInput'
import { FIELD_STYLE } from './common'

const ROW = { display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' } as const
const LOCAL = providerFor('local')

type Probe = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; models: string[] } | { state: 'fail'; error: string }

export function MonitorRows() {
  const s = useConductorSelector(x => ({
    provider: x.settings.provider,
    monitorProvider: x.settings.monitorProvider,
    monitorBaseUrl: x.settings.monitorBaseUrl,
    monitorModel: x.settings.monitorModel,
  }), shallowEqual)
  const { updateSettings } = useActions()
  const [probe, setProbe] = useState<Probe>({ state: 'idle' })
  // a Master already on the local provider makes "local monitors" the default
  const local = (s.monitorProvider ?? '') === 'local' || (!s.monitorProvider && s.provider === 'local')
  const ownServer = (s.monitorProvider ?? '') === 'local' && s.provider !== 'local'
  const base = openAiBase({ provider: LOCAL, baseUrl: s.monitorBaseUrl ?? '' })
  const suggestions = probe.state === 'ok' && probe.models.length
    ? probe.models
    : (local ? LOCAL.models : providerFor(s.provider).models)

  const detect = async () => {
    setProbe({ state: 'busy' })
    try {
      const models = await listServerModels(base, AbortSignal.timeout(4000))
      setProbe({ state: 'ok', models })
      if (models.length && !models.includes(s.monitorModel)) updateSettings({ monitorModel: models[0] })
    } catch (e) {
      setProbe({ state: 'fail', error: e instanceof Error ? e.message : String(e) })
    }
  }

  return <>
    <div style={ROW}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Monitor provider</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
          Monitors, task watchers and addon agents run on every settle. Point them at a small model on this machine to keep Master remote without the per-session API cost.
        </div>
      </div>
      <select
        value={s.monitorProvider === 'local' ? 'local' : ''}
        onChange={e => {
          const next = e.target.value
          setProbe({ state: 'idle' })
          updateSettings(next === 'local'
            ? { monitorProvider: 'local', monitorModel: LOCAL.models[0] }
            : { monitorProvider: '', monitorModel: '' })
        }}
        style={{ ...FIELD_STYLE, width: 260 }}
      >
        <option value="">Same as Master</option>
        <option value="local">{LOCAL.label}</option>
      </select>
    </div>
    {ownServer && (
      <div style={ROW}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Local server</div>
          <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
            Ollama <span className="mono">:11434/v1</span>, LM Studio <span className="mono">:1234/v1</span>, llama-server <span className="mono">:8080/v1</span>.
            Give Ollama at least an 8k context (<span className="mono">OLLAMA_CONTEXT_LENGTH=8192</span>): it silently truncates longer screens.
          </div>
          {probe.state === 'ok' && (
            <div style={{ fontSize: 11.5, marginTop: 5, color: probe.models.length ? 'var(--green)' : 'var(--amber)' }}>
              {probe.models.length
                ? `Connected · ${probe.models.length} model${probe.models.length === 1 ? '' : 's'}`
                : 'Connected, but no models are installed. Try: ollama pull qwen3:1.7b'}
            </div>
          )}
          {probe.state === 'fail' && (
            <div style={{ fontSize: 11.5, marginTop: 5, color: 'var(--red-soft)' }}>Can't reach {base}: {probe.error}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, width: 260 }}>
          <DraftInput
            value={s.monitorBaseUrl ?? ''}
            onCommit={v => { setProbe({ state: 'idle' }); updateSettings({ monitorBaseUrl: v }) }}
            placeholder={LOCAL.base}
            style={{ ...FIELD_STYLE, flex: 1, minWidth: 0 }}
          />
          <button className="open-btn" disabled={probe.state === 'busy'} onClick={() => void detect()} style={{ flexShrink: 0 }}>
            {probe.state === 'busy' ? 'Testing…' : 'Test'}
          </button>
        </div>
      </div>
    )}
    <div style={ROW}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Monitor model</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
          {local
            ? 'qwen3:1.7b writes the best digests at this size; qwen3:0.6b is faster on CPU-only machines.'
            : 'Each session gets its own monitor LLM that watches output and only escalates digests to Master. Use a cheap model.'}
        </div>
      </div>
      <DraftInput
        list="monitor-models"
        value={s.monitorModel}
        onCommit={v => updateSettings({ monitorModel: v })}
        placeholder={ownServer ? LOCAL.models[0] : 'same as Master model'}
        style={{ ...FIELD_STYLE, width: 260 }}
      />
      <datalist id="monitor-models">
        {suggestions.map(m => <option key={m} value={m} />)}
      </datalist>
    </div>
  </>
}
