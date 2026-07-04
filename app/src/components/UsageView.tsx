import { useConductor } from '../store'
import { ESTIMATED_OUTPUT_COST_PER_KTOK, formatEstimatedTokens } from '../usage'
import { AgentAvatar, ViewHeader } from './ui'

/** Render one aggregate usage metric with its explanatory subtitle. */
function StatCard({ label, value, sub, valueColor }: { label: string; value: string; sub: string; valueColor?: string }) {
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 16 }}>
      <div style={{ fontSize: 11.5, color: 'var(--mut)' }}>{label}</div>
      <div className="grotesk" style={{ fontSize: 26, fontWeight: 600, marginTop: 5, color: valueColor }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--dim)', marginTop: 3 }}>{sub}</div>
    </div>
  )
}

/** Aggregate and display terminal-output usage estimates for active sessions. */
export function UsageView() {
  const s = useConductor()
  const agents = s.agents.filter(a => (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
  const totalCost = agents.reduce((n, a) => n + a.cost, 0)
  const totalBudget = agents.reduce((n, a) => n + a.budget, 0)
  const totalTokens = agents.reduce((n, a) => n + a.used, 0)
  const runningCount = agents.filter(a => a.status === 'running' || a.status === 'needs').length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Usage estimates">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Session terminal output · this workspace</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 22 }}>
          <StatCard
            label="Output cost (est.)"
            value={`$${totalCost.toFixed(2)}`}
            sub={`$${totalBudget.toFixed(2)} budget · ${totalBudget > 0 ? Math.round((totalCost / totalBudget) * 100) : 0}% used`}
          />
          <StatCard label="Output tokens (est.)" value={formatEstimatedTokens(totalTokens)} sub={`across ${agents.length} sessions`} />
          <StatCard label="Active processes" value={String(runningCount)} sub={`of ${agents.length} sessions`} valueColor="var(--green)" />
        </div>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--dim)', margin: '-8px 2px 14px' }}>
          Estimated from printable terminal output at ~4 characters per token and ${ESTIMATED_OUTPUT_COST_PER_KTOK.toFixed(2)} per 1k output tokens.
          {' '}Input, cache, reasoning, subscription, and provider billing data are not visible to YAAM.
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 14, padding: '6px 18px' }}>
          {agents.map(a => {
            const pct = a.budget > 0 ? Math.min(100, Math.round((a.cost / a.budget) * 100)) : 0
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 0', borderBottom: '1px solid #1a1e26' }}>
                <AgentAvatar agent={a} size={30} />
                <div style={{ width: 130, flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{formatEstimatedTokens(a.used)}</div>
                </div>
                <div style={{ flex: 1, height: 9, background: 'var(--panel2)', borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: a.color, borderRadius: 6 }} />
                </div>
                <div style={{ width: 120, textAlign: 'right', flexShrink: 0 }}>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>${a.cost.toFixed(2)}</span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 5 }}>of ${a.budget.toFixed(2)}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
