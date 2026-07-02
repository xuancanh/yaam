import type { Agent, AgentTool, AppState, DiffFile, LogLine, MemorySource, Perm, Snapshot } from './types'

export const ACCENT = '#F5C451'

export const LOG_COLORS: Record<string, string> = {
  sys: '#5B6472',
  you: '#E7E9F0',
  run: '#7FD1FF',
  out: '#8B93A1',
  think: '#D9B778',
  edit: '#7FE3B0',
  warn: '#FFB020',
  err: '#FF7A7A',
}

export const STATUS_META: Record<string, { label: string; color: string }> = {
  running: { label: 'Running', color: '#3DDC97' },
  idle: { label: 'Paused', color: '#6B7280' },
  needs: { label: 'Needs action', color: '#FFB020' },
  error: { label: 'Error', color: '#FF5C5C' },
}

export const PERM_COLORS: Record<Perm, string> = {
  Off: '#6B7280',
  'Ask first': '#FFB020',
  Auto: '#3DDC97',
  Approval: '#FF5C5C',
}

export const PERM_ORDER: Perm[] = ['Off', 'Ask first', 'Auto', 'Approval']

export const EVENT_COLORS: Record<string, string> = {
  route: ACCENT,
  edit: '#7FE3B0',
  test: '#7FD1FF',
  escalate: '#FFB020',
  cron: '#8B93A1',
  build: ACCENT,
  done: '#3DDC97',
}

export const NOTIF_COLORS: Record<string, string> = {
  escalate: '#FFB020',
  done: '#3DDC97',
  cron: '#8B93A1',
}

export const DIFF_COLORS: Record<string, string> = {
  add: '#7FE3B0',
  del: '#FF9B9B',
  ctx: '#8B93A1',
  meta: ACCENT,
}

export const DIFF_BG: Record<string, string> = {
  add: 'rgba(61,220,151,.09)',
  del: 'rgba(255,92,92,.09)',
  ctx: 'transparent',
  meta: 'rgba(245,196,81,.08)',
}

export function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export const CLAUDE_FEED: LogLine[] = [
  { t: 'run', x: '$ pnpm test middleware/rateLimit' },
  { t: 'out', x: 'PASS  4 passed · 212ms' },
  { t: 'think', x: 'Wiring the limiter into the request pipeline…' },
  { t: 'edit', x: '~ src/server/pipeline.ts  (+6 −1)' },
  { t: 'run', x: '$ git add -A && git commit -m "feat: token-bucket limiter"' },
  { t: 'out', x: '[feat/rate-limiter 8a1f9c2] feat: token-bucket limiter' },
]

export const AIDER_APPROVE_FEED: LogLine[] = [
  { t: 'run', x: '$ alembic upgrade head' },
  { t: 'out', x: 'INFO  running migration 0007_webhook_events' },
  { t: 'out', x: 'INFO  migration complete ✓' },
  { t: 'edit', x: '~ billing/webhooks/stripe.py  (+34 −2)' },
  { t: 'run', x: '$ pytest billing/tests/test_webhooks.py' },
  { t: 'out', x: '==== 9 passed in 3.41s ====' },
]

export function mkMemory(): MemorySource[] {
  return [
    { id: 'repomap', label: 'Repository map', detail: 'auto-indexed · 1,204 files', tokens: 8.1, on: true },
    { id: 'guide', label: 'Project guide', detail: 'CLAUDE.md · conventions', tokens: 2.3, on: true },
    { id: 'diffs', label: 'Recent diffs', detail: 'last 12 commits', tokens: 4.7, on: true },
    { id: 'ticket', label: 'Linked ticket', detail: 'ENG-2214', tokens: 0.9, on: true },
    { id: 'summary', label: 'Session summary', detail: 'rolling context', tokens: 3.2, on: true },
    { id: 'slack', label: 'Slack thread', detail: '#eng-platform', tokens: 1.1, on: false },
  ]
}

export function mkTools(): AgentTool[] {
  return [
    { id: 'shell', name: 'Shell', on: true, perm: 'Ask first' },
    { id: 'fs', name: 'File write', on: true, perm: 'Auto' },
    { id: 'git', name: 'Git', on: true, perm: 'Auto' },
    { id: 'http', name: 'HTTP fetch', on: true, perm: 'Ask first' },
    { id: 'db', name: 'DB query', on: false, perm: 'Approval' },
    { id: 'browser', name: 'Browser', on: false, perm: 'Off' },
  ]
}

interface AgentDetail {
  used: number
  cost: number
  budget: number
  snaps: Snapshot[]
  diff: DiffFile[]
}

const AGENT_DETAILS: Record<string, AgentDetail> = {
  'a-claude': {
    used: 38.2, cost: 1.42, budget: 5.0,
    snaps: [
      { label: 'before pipeline edit', time: '8m ago' },
      { label: 'rateLimit.ts created', time: '5m ago' },
      { label: 'tests green', time: '2m ago' },
    ],
    diff: [
      {
        file: 'src/server/middleware/rateLimit.ts', add: 48, del: 0,
        hunks: [
          { t: 'meta', x: '@@ new file · src/server/middleware/rateLimit.ts @@' },
          { t: 'add', x: 'export class RateLimiter {' },
          { t: 'add', x: '  constructor(private redis: Redis, private rps = 100) {}' },
          { t: 'add', x: '  async allow(key: string) {' },
          { t: 'add', x: '    const n = await this.redis.incr(`rl:${key}`);' },
          { t: 'add', x: '    if (n === 1) await this.redis.expire(`rl:${key}`, 1);' },
          { t: 'add', x: '    return n <= this.rps;' },
          { t: 'add', x: '  }' },
          { t: 'add', x: '}' },
        ],
      },
      {
        file: 'src/server/pipeline.ts', add: 6, del: 1,
        hunks: [
          { t: 'meta', x: '@@ -12,7 +12,12 @@ src/server/pipeline.ts' },
          { t: 'ctx', x: ' import { auth } from "./middleware/auth";' },
          { t: 'add', x: '+import { RateLimiter } from "./middleware/rateLimit";' },
          { t: 'ctx', x: ' export function pipeline(app: App) {' },
          { t: 'del', x: '-  app.use(auth);' },
          { t: 'add', x: '+  const limiter = new RateLimiter(redis);' },
          { t: 'add', x: '+  app.use((req, res, next) =>' },
          { t: 'add', x: '+    limiter.allow(req.ip).then(ok => ok ? next() : res.status(429).end()));' },
          { t: 'add', x: '+  app.use(auth);' },
        ],
      },
    ],
  },
  'a-codex': {
    used: 21.7, cost: 0.31, budget: 3.0,
    snaps: [
      { label: 'traced redirect chain', time: '7m ago' },
      { label: 'redirect fix', time: '5m ago' },
    ],
    diff: [
      {
        file: 'src/auth/callback.ts', add: 11, del: 4,
        hunks: [
          { t: 'meta', x: '@@ -30,10 +30,17 @@ src/auth/callback.ts' },
          { t: 'ctx', x: ' export async function handleCallback(req, res) {' },
          { t: 'del', x: '-  const session = req.cookies.session;' },
          { t: 'del', x: '-  if (session) return res.redirect("/app");' },
          { t: 'add', x: '+  const session = await verify(req.cookies.session);' },
          { t: 'add', x: '+  if (session?.valid) return res.redirect("/app");' },
          { t: 'add', x: '+  // stale cookie caused the redirect loop — clear it' },
          { t: 'add', x: '+  res.clearCookie("session");' },
          { t: 'ctx', x: '   const token = await exchange(req.query.code);' },
          { t: 'add', x: '+  res.cookie("session", token, { httpOnly: true });' },
          { t: 'ctx', x: '   return res.redirect("/app");' },
        ],
      },
    ],
  },
  'a-gemini': {
    used: 14.3, cost: 0.52, budget: 4.0,
    snaps: [{ label: 'dry-run ok', time: '24m ago' }],
    diff: [
      {
        file: 'etl/transform/normalize.py', add: 22, del: 9,
        hunks: [
          { t: 'meta', x: '@@ -8,9 +8,22 @@ etl/transform/normalize.py' },
          { t: 'del', x: '-    return df.merge(dim, on="key")' },
          { t: 'add', x: '+    df = df.drop_duplicates(subset=["key"])' },
          { t: 'add', x: '+    dim = dim.drop_duplicates(subset=["key"])' },
          { t: 'add', x: '+    return df.merge(dim, on="key", validate="m:1")' },
        ],
      },
    ],
  },
  'a-aider': {
    used: 44.9, cost: 2.73, budget: 6.0,
    snaps: [{ label: 'migration generated', time: 'just now' }],
    diff: [
      {
        file: 'alembic/versions/0007_webhook_events.py', add: 61, del: 0,
        hunks: [
          { t: 'meta', x: '@@ new file · alembic/versions/0007_webhook_events.py @@' },
          { t: 'add', x: 'def upgrade():' },
          { t: 'add', x: '    op.create_table("webhook_events",' },
          { t: 'add', x: '        sa.Column("id", sa.String, primary_key=True),' },
          { t: 'add', x: '        sa.Column("type", sa.String, nullable=False),' },
          { t: 'add', x: '        sa.Column("payload", sa.JSON))' },
        ],
      },
      {
        file: 'billing/webhooks/stripe.py', add: 34, del: 2,
        hunks: [
          { t: 'meta', x: '@@ -1,4 +1,20 @@ billing/webhooks/stripe.py' },
          { t: 'add', x: '+@router.post("/webhooks/stripe")' },
          { t: 'add', x: '+async def handle(req: Request):' },
          { t: 'add', x: '+    event = stripe.Webhook.construct_event(...)' },
          { t: 'add', x: '+    await store_event(event)' },
        ],
      },
    ],
  },
}

export function defaultDetail(): AgentDetail {
  return { used: 10.0, cost: 0.2, budget: 3.0, snaps: [{ label: 'session start', time: '—' }], diff: [] }
}

function seedAgents(): Agent[] {
  const base: Array<Omit<Agent, keyof AgentDetail>> = [
    {
      id: 'a-claude', name: 'Claude Code', short: 'CC', color: '#E8A87C',
      repo: 'api-gateway', branch: 'feat/rate-limiter', status: 'running',
      model: 'claude-sonnet-4.5', fi: 0, feed: CLAUDE_FEED,
      memory: mkMemory(), tools: mkTools(),
      log: [
        { t: 'sys', x: 'session resumed · api-gateway @ feat/rate-limiter' },
        { t: 'you', x: 'add token-bucket rate limiting to the gateway middleware' },
        { t: 'run', x: '$ rg "middleware" src/ -l' },
        { t: 'out', x: 'src/server/pipeline.ts' },
        { t: 'out', x: 'src/server/middleware/index.ts' },
        { t: 'think', x: 'Adding a RateLimiter with a Redis-backed token bucket…' },
        { t: 'edit', x: '+ src/server/middleware/rateLimit.ts  (48 lines)' },
        { t: 'edit', x: '~ src/server/pipeline.ts  (+6 −1)' },
      ],
    },
    {
      id: 'a-codex', name: 'Codex', short: 'CX', color: '#34D399',
      repo: 'web-dashboard', branch: 'fix/auth-redirect', status: 'running',
      model: 'gpt-5-codex', fi: 0,
      feed: [
        { t: 'run', x: '$ npm run typecheck' },
        { t: 'out', x: 'tsc --noEmit  ✓  0 errors' },
        { t: 'think', x: 'Redirect loop is caused by a stale session cookie…' },
        { t: 'edit', x: '~ src/auth/callback.ts  (+11 −4)' },
        { t: 'run', x: '$ npm run test:e2e auth' },
        { t: 'out', x: '✓ auth › redirects to /app after login (1.2s)' },
      ],
      memory: mkMemory(), tools: mkTools(),
      log: [
        { t: 'sys', x: 'session resumed · web-dashboard @ fix/auth-redirect' },
        { t: 'you', x: 'fix the infinite redirect after OAuth login' },
        { t: 'think', x: 'Tracing the redirect chain from /callback…' },
        { t: 'edit', x: '~ src/auth/callback.ts  (+11 −4)' },
      ],
    },
    {
      id: 'a-gemini', name: 'Gemini CLI', short: 'GM', color: '#6C8EF5',
      repo: 'data-pipeline', branch: 'chore/etl-refactor', status: 'idle',
      model: 'gemini-2.5-pro', fi: 0,
      feed: [
        { t: 'run', x: '$ python -m etl.run --dry' },
        { t: 'out', x: 'planned 14 stages · 3 sources' },
        { t: 'think', x: 'Deduping join keys before the load step…' },
        { t: 'edit', x: '~ etl/transform/normalize.py  (+22 −9)' },
        { t: 'out', x: 'validated schema: 0 drift' },
      ],
      memory: mkMemory(), tools: mkTools(),
      log: [
        { t: 'sys', x: 'session paused · data-pipeline @ chore/etl-refactor' },
        { t: 'out', x: 'last run: dry-run ok, 14 stages planned' },
        { t: 'sys', x: 'paused 24m ago — resume to continue' },
      ],
    },
    {
      id: 'a-aider', name: 'Aider', short: 'AD', color: '#C77DFF',
      repo: 'billing-service', branch: 'feat/stripe-webhooks', status: 'needs',
      model: 'claude-opus-4', fi: 0, feed: AIDER_APPROVE_FEED,
      memory: mkMemory(), tools: mkTools(),
      escReason: 'It wants to run alembic upgrade head to add a webhook_events table — a destructive migration against the shared dev database.',
      log: [
        { t: 'sys', x: 'session resumed · billing-service @ feat/stripe-webhooks' },
        { t: 'you', x: 'wire up stripe webhook handlers and persist events' },
        { t: 'run', x: '$ rg "webhook" -l' },
        { t: 'out', x: 'billing/webhooks/stripe.py' },
        { t: 'think', x: 'Need a new events table — generating a migration.' },
        { t: 'edit', x: '+ alembic/versions/0007_webhook_events.py  (61 lines)' },
        { t: 'warn', x: '! wants to run: alembic upgrade head  (destructive)' },
      ],
    },
  ]
  return base.map(a => ({ ...a, ...(AGENT_DETAILS[a.id] || defaultDetail()) }))
}

export function seedState(): AppState {
  return {
    view: 'workspace',
    activePane: 0,
    splitCount: 2,
    focusedIds: ['a-claude', 'a-aider'],
    composer: '',
    panel: null,
    toast: null,
    drawer: null,
    paletteOpen: false,
    paletteQuery: '',
    notifOpen: false,
    dragOverCol: null,
    agents: seedAgents(),
    events: [
      { id: 'e1', type: 'route', agentId: 'a-claude', text: 'Routed “token-bucket rate limiting” to Claude Code', time: '12m ago' },
      { id: 'e2', type: 'route', agentId: 'a-codex', text: 'Assigned “auth redirect fix” to Codex', time: '12m ago' },
      { id: 'e3', type: 'edit', agentId: 'a-claude', text: 'Created src/server/middleware/rateLimit.ts', time: '9m ago' },
      { id: 'e4', type: 'test', agentId: 'a-codex', text: 'E2E passed · redirects to /app after login', time: '6m ago' },
      { id: 'e5', type: 'escalate', agentId: 'a-aider', text: 'Aider blocked — wants a destructive migration', time: '4m ago' },
      { id: 'e6', type: 'cron', agentId: null, text: 'nightly-regression finished · api-gateway', time: '6h ago' },
    ],
    notifications: [
      { id: 'n1', kind: 'escalate', title: 'Aider needs your approval', detail: 'Destructive DB migration · billing-service', time: '4m ago', read: false, agentId: 'a-aider' },
      { id: 'n2', kind: 'done', title: 'Codex finished the auth redirect fix', detail: 'Ready for review · web-dashboard', time: '6m ago', read: false, agentId: 'a-codex' },
      { id: 'n3', kind: 'cron', title: 'nightly-regression passed', detail: 'api-gateway · 6h ago', time: '6h ago', read: true, agentId: null },
    ],
    agentTypes: [
      { id: 'claude', name: 'Claude Code', color: '#E8A87C', model: 'claude-sonnet-4.5', tools: 6, desc: 'Anthropic CLI — deep multi-file edits, tests, and refactors.', enabled: true },
      { id: 'codex', name: 'Codex', color: '#34D399', model: 'gpt-5-codex', tools: 6, desc: 'OpenAI CLI — fast fixes, typechecking, and e2e.', enabled: true },
      { id: 'gemini', name: 'Gemini CLI', color: '#6C8EF5', model: 'gemini-2.5-pro', tools: 5, desc: 'Google CLI — very large-context refactors.', enabled: true },
      { id: 'aider', name: 'Aider', color: '#C77DFF', model: 'claude-opus-4', tools: 6, desc: 'Pair-programming CLI — git-native diffs.', enabled: true },
      { id: 'cursor', name: 'Cursor Agent', color: '#9AA3B2', model: 'composer-1', tools: 4, desc: 'Background agent — repo-wide autonomous tasks.', enabled: false },
    ],
    integrations: [
      { id: 'github', name: 'GitHub', cat: 'Source control', detail: '4 repositories connected', connected: true },
      { id: 'linear', name: 'Linear', cat: 'Issue tracking', detail: 'ENG project · auto-link', connected: true },
      { id: 'slack', name: 'Slack', cat: 'Notifications', detail: '#eng-platform', connected: true },
      { id: 'postgres', name: 'Postgres', cat: 'Databases', detail: 'dev + staging', connected: true },
      { id: 'figma', name: 'Figma (MCP)', cat: 'Design', detail: 'read-only export', connected: true },
      { id: 'stripe', name: 'Stripe', cat: 'Payments', detail: 'not connected', connected: false },
      { id: 'sentry', name: 'Sentry', cat: 'Monitoring', detail: 'not connected', connected: false },
      { id: 'vercel', name: 'Vercel', cat: 'Deploy', detail: 'not connected', connected: false },
    ],
    settings: { autoRoute: true, approveDestructive: true, followMode: true },
    tasks: [
      { id: 't1', title: 'Token-bucket rate limiting on the gateway', col: 'progress', agentId: 'a-claude' },
      { id: 't2', title: 'Fix infinite OAuth redirect loop', col: 'progress', agentId: 'a-codex' },
      { id: 't3', title: 'Persist Stripe webhook events + migration', col: 'review', agentId: 'a-aider' },
      { id: 't4', title: 'Refactor ETL to dedupe join keys', col: 'routed', agentId: 'a-gemini' },
      { id: 't5', title: 'Add distributed request tracing', col: 'backlog', agentId: null },
      { id: 't6', title: 'Migrate logging to OpenTelemetry', col: 'backlog', agentId: null },
      { id: 't7', title: 'Config UI for rate-limit tiers', col: 'backlog', agentId: null },
      { id: 't8', title: 'Weekly dependency audit', col: 'done', agentId: 'a-codex' },
      { id: 't9', title: 'Stabilize flaky auth e2e tests', col: 'done', agentId: 'a-claude' },
    ],
    messages: [
      { id: 'm1', role: 'you', kind: 'text', text: 'Add token-bucket rate limiting to the API gateway and fix the auth redirect bug on the dashboard.' },
      {
        id: 'm2', role: 'master', kind: 'route', text: 'Parsed 2 tasks — routing each to the right session:',
        routes: [
          { name: 'Claude Code', color: '#E8A87C', repo: 'api-gateway', task: 'rate limiting', action: 'resumed' },
          { name: 'Codex', color: '#34D399', repo: 'web-dashboard', task: 'auth redirect', action: 'assigned' },
        ],
      },
      { id: 'm3', role: 'master', kind: 'text', text: 'Following both sessions. I’ll only ping you when something needs a decision.' },
      {
        id: 'm4', role: 'master', kind: 'escalate', escFor: 'a-aider',
        esc: {
          name: 'Aider', color: '#C77DFF', repo: 'billing-service',
          reason: 'It’s blocked on a destructive DB migration (alembic upgrade head) to add a webhook_events table. Approve to let it proceed.',
          resolved: false, decision: null,
        },
      },
    ],
    crons: [
      { id: 'c1', name: 'nightly-regression', schedule: '0 2 * * *', human: 'Every day · 2:00 AM', target: 'api-gateway', agent: 'Claude Code', color: '#E8A87C', on: true, built: true, last: 'passed · 6h ago' },
      { id: 'c2', name: 'dep-audit', schedule: '0 9 * * 1', human: 'Mondays · 9:00 AM', target: 'all repos', agent: 'Codex', color: '#34D399', on: true, built: false, last: '2 advisories · 3d ago' },
      { id: 'c3', name: 'stale-branch-sweep', schedule: '0 18 * * 5', human: 'Fridays · 6:00 PM', target: 'all repos', agent: 'Gemini CLI', color: '#6C8EF5', on: false, built: true, last: '—' },
    ],
    toolsCatalog: [
      { id: 'shell', name: 'Shell', desc: 'Run commands in the workspace sandbox.', perm: 'Ask first', agents: 4 },
      { id: 'fs', name: 'File write', desc: 'Create and edit files in the repository.', perm: 'Auto', agents: 4 },
      { id: 'git', name: 'Git', desc: 'Stage, commit, branch, and push changes.', perm: 'Auto', agents: 4 },
      { id: 'http', name: 'HTTP fetch', desc: 'Outbound requests to allowlisted hosts only.', perm: 'Ask first', agents: 3 },
      { id: 'db', name: 'DB query', desc: 'Read and write against connected databases.', perm: 'Approval', agents: 1 },
      { id: 'browser', name: 'Browser', desc: 'Headless browsing and page scraping.', perm: 'Off', agents: 0 },
      { id: 'figma', name: 'Figma (MCP)', desc: 'Read designs and export assets.', perm: 'Auto', agents: 2 },
      { id: 'deploy', name: 'Deploy', desc: 'Ship builds to staging and production.', perm: 'Approval', agents: 0 },
    ],
  }
}
