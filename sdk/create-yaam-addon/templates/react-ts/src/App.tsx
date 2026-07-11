import { useState } from 'react'
import { useStorage, useYaam, useYaamState } from '@yaam/addon-sdk/react'

/** Starter view: live board overview + a persisted note. Replace freely. */
export function App() {
  const yaam = useYaam()
  const state = useYaamState()
  const note = useStorage('note', '')
  const [draft, setDraft] = useState<string | null>(null)

  if (!state) {
    return <div className="empty">waiting for the host… (needs the state:read grant)</div>
  }

  const cols = ['backlog', 'progress', 'review', 'done', 'failed'] as const
  return (
    <div>
      <h1>__ICON__ __ADDON_NAME__</h1>
      <div className="sub">workspace “{state.workspace}” · {state.totals.running} running · ${state.totals.cost.toFixed(2)} spent</div>

      <h2>Board</h2>
      <div className="row">
        {cols.map(col => (
          <div key={col} className="card" style={{ minWidth: 90 }}>
            <div className="mono" style={{ fontSize: 20 }}>{state.tasks.filter(t => t.col === col).length}</div>
            <div className="sub">{col}</div>
          </div>
        ))}
      </div>

      <h2>Note <span className="sub">(persisted via storage)</span></h2>
      <div className="row">
        <input
          className="grow"
          value={draft ?? note.value}
          placeholder={note.loading ? 'loading…' : 'jot something down'}
          onChange={e => setDraft(e.target.value)}
        />
        <button
          className="primary"
          disabled={draft === null || draft === note.value}
          onClick={() => {
            if (draft !== null) note.set(draft)
            setDraft(null)
            void yaam.guard(yaam.api.flash('note saved'))
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}
