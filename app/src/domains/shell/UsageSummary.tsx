import { useState } from 'react'
import { useConductor } from '../../store'
import { ESTIMATED_OUTPUT_COST_PER_KTOK, formatEstimatedTokens } from '../../usage'

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

/** Collapsible workspace-wide usage totals shown at the top of the Agents view. */
export function UsageSummary() {
  const s = useConductor()
  const [open, setOpen] = useState(false)
  const agents = s.agents.filter(a => (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
  const totalCost = agents.reduce((n, a) => n + a.cost, 0)
  const totalBudget = agents.reduce((n, a) => n + a.budget, 0)
  const totalTokens = agents.reduce((n, a) => n + a.used, 0)
  const runningCount = agents.filter(a => a.status === 'running' || a.status === 'needs').length

  return (
    <div style={{ marginBottom: 18 }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="mono"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none',
          color: 'var(--mut)', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, padding: '2px 0', cursor: 'pointer',
        }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▸</span>
        USAGE ESTIMATES
        <span style={{ fontWeight: 400, letterSpacing: 0.2, color: 'var(--dim)' }}>
          ${totalCost.toFixed(2)} · {formatEstimatedTokens(totalTokens)} · session terminal output, this workspace
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <StatCard
              label="Output cost (est.)"
              value={`$${totalCost.toFixed(2)}`}
              sub={`$${totalBudget.toFixed(2)} budget · ${totalBudget > 0 ? Math.round((totalCost / totalBudget) * 100) : 0}% used`}
            />
            <StatCard label="Output tokens (est.)" value={formatEstimatedTokens(totalTokens)} sub={`across ${agents.length} sessions`} />
            <StatCard label="Active processes" value={String(runningCount)} sub={`of ${agents.length} sessions`} valueColor="var(--green)" />
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--dim)', margin: '10px 2px 0' }}>
            Estimated from printable terminal output at ~4 characters per token and ${ESTIMATED_OUTPUT_COST_PER_KTOK.toFixed(2)} per 1k output tokens.
            {' '}Input, cache, reasoning, subscription, and provider billing data are not visible to YAAM.
          </div>
        </div>
      )}
    </div>
  )
}
