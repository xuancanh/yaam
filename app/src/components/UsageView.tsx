import { useConductor } from '../store'
import { AgentAvatar, ViewHeader } from './ui'

function StatCard({ label, value, sub, valueColor }: { label: string; value: string; sub: string; valueColor?: string }) {
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 16 }}>
      <div style={{ fontSize: 11.5, color: 'var(--mut)' }}>{label}</div>
      <div className="grotesk" style={{ fontSize: 26, fontWeight: 600, marginTop: 5, color: valueColor }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--dim)', marginTop: 3 }}>{sub}</div>
    </div>
  )
}

export function UsageView() {
  const s = useConductor()
  const totalCost = s.agents.reduce((n, a) => n + a.cost, 0)
  const totalBudget = s.agents.reduce((n, a) => n + a.budget, 0)
  const totalTokens = s.agents.reduce((n, a) => n + a.used, 0)
  const runningCount = s.agents.filter(a => a.status === 'running').length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Cost & usage">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Tokens and spend per agent · this week</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 22 }}>
          <StatCard
            label="Total spend"
            value={`$${totalCost.toFixed(2)}`}
            sub={`$${totalBudget.toFixed(2)} budget · ${Math.round((totalCost / totalBudget) * 100)}% used`}
          />
          <StatCard label="Tokens" value={`${totalTokens.toFixed(1)}k`} sub={`across ${s.agents.length} sessions`} />
          <StatCard label="Running now" value={String(runningCount)} sub={`of ${s.agents.length} sessions`} valueColor="var(--green)" />
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 14, padding: '6px 18px' }}>
          {s.agents.map(a => {
            const pct = Math.min(100, Math.round((a.cost / a.budget) * 100))
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 0', borderBottom: '1px solid #1a1e26' }}>
                <AgentAvatar agent={a} size={30} />
                <div style={{ width: 130, flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{a.used.toFixed(1)}k tok</div>
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
