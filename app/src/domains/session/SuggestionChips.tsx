import { useActions } from '../../store'
import type { Agent } from '../../core/types'
import { IC, Icon } from '../../components/ui'

// The monitor's proposed next actions for a session, as one-click chips along
// the bottom of the pane. Clicking sends the action's text straight to the session
// (and records the acceptance so the harness learns); ✕ dismisses the set
// (recorded too — the implicit-feedback eval).

export function SuggestionChips({ agent }: { agent: Agent }) {
  const { runSuggestion, dismissSuggestions } = useActions()
  const suggestions = agent.suggestions ?? []
  if (!suggestions.length) return null
  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
      background: 'rgba(245,196,81,.05)', borderTop: '1px solid var(--line)', overflowX: 'auto',
    }}>
      <span className="mono" title="Suggested by this session's monitor — click to send" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--accent)', flexShrink: 0 }}>
        ✦ NEXT
      </span>
      {suggestions.map(sug => (
        <button
          key={sug.id}
          className="open-btn"
          title={`Send to the session: ${sug.send}`}
          onClick={() => runSuggestion(agent.id, sug.id)}
          style={{ flexShrink: 0, padding: '4px 11px', fontSize: 11.5, whiteSpace: 'nowrap' }}
        >
          {sug.label}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button
        className="icon-btn"
        title="Dismiss suggestions"
        onClick={() => dismissSuggestions(agent.id)}
        style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0 }}
      >
        <Icon paths={IC.close} size={9} stroke={2} />
      </button>
    </div>
  )
}
