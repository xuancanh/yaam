// Settings domain AppState slice. Imports only entity types (never core/types).
import type {
  OrchestrationSettings, AgentType, ChatAgentType, McpServer, Skill, Persona, SkillRegistry, CatalogTool,
} from '../../core/entities'

/** Configuration: orchestration policy, agent/chat types, MCP, skills, personas, tools. */
export interface SettingsSlice {
  settings: OrchestrationSettings
  agentTypes: AgentType[]
  chatAgentTypes: ChatAgentType[]
  mcpServers: McpServer[]
  skills: Skill[]
  personas: Persona[]
  skillRegistries: SkillRegistry[]
  toolsCatalog: CatalogTool[]
}

/** Initial settings slice: default providers, agent/chat types, starter skills,
 *  a persona, the anthropic skill registry, and Master's tool catalog. */
export function freshSettingsSlice(): SettingsSlice {
  return {
    agentTypes: [
      { id: 'claude', name: 'Claude Code', color: '#E8A87C', model: 'claude', tools: 6, desc: 'Anthropic CLI — deep multi-file edits, tests, and refactors.', enabled: true, resumeCmd: 'claude --resume {id}', resumeFallbackCmd: 'claude --continue', probe: 'claude' },
      { id: 'codex', name: 'Codex', color: '#34D399', model: 'codex', tools: 6, desc: 'OpenAI CLI — fast fixes, typechecking, and e2e.', enabled: true, resumeCmd: 'codex resume {id}', resumeFallbackCmd: 'codex resume --last', probe: 'codex' },
      { id: 'gemini', name: 'Gemini CLI', color: '#6C8EF5', model: 'gemini', tools: 5, desc: 'Google CLI — very large-context refactors.', enabled: true },
      { id: 'aider', name: 'Aider', color: '#C77DFF', model: 'aider', tools: 6, desc: 'Pair-programming CLI — git-native diffs.', enabled: true, resumeCmd: 'aider --restore-chat-history' },
      { id: 'cursor', name: 'Cursor Agent', color: 'var(--mut2)', model: 'cursor-agent', tools: 4, desc: 'Background agent — repo-wide autonomous tasks.', enabled: false },
    ],
    mcpServers: [],
    personas: [
      {
        id: 'persona-terse-engineer',
        name: 'terse-engineer',
        description: 'Senior engineer voice: short, direct, evidence-first.',
        body: 'Speak like a senior engineer in a hurry: lead with the answer, cite file:line for claims about code, prefer diffs over descriptions, flag risks in one line each, no pleasantries.',
      },
    ],
    skillRegistries: [
      { id: 'sr-anthropic', name: 'anthropic', url: 'https://github.com/anthropics/skills/tree/main/skills', enabled: true },
    ],
    chatAgentTypes: [
      { id: 'chat-claude', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5', models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'], enabled: true, desc: 'Shares the Master Brain credentials unless a key is set.' },
      { id: 'chat-gpt', name: 'GPT', provider: 'openai', model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'], enabled: false, desc: 'Needs an OpenAI API key.' },
      { id: 'chat-deepseek', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], enabled: false, desc: 'Needs a DeepSeek API key.' },
      { id: 'chat-gemini', name: 'Gemini', provider: 'gemini', model: 'gemini-2.5-flash', models: ['gemini-2.5-flash', 'gemini-2.5-pro'], enabled: false, desc: 'Needs a Google AI Studio key.' },
    ],
    skills: [
      {
        id: 'skill-deep-research',
        name: 'deep-research',
        description: 'Multi-source research with fact-checking: search, read several sources, cross-check claims, cite everything.',
        body: 'Research the question in stages. 1) web_search 2-4 differently-phrased queries; collect candidate sources. 2) fetch_url the 3-6 most credible/diverse sources (primary sources > news > blogs; check dates). 3) Cross-check: a claim counts as established only when 2+ independent sources agree; note disagreements explicitly instead of averaging them away. 4) Answer with a short conclusion first, then the evidence, then a Sources list of the URLs actually used. Say clearly when something could not be verified.',
      },
      {
        id: 'skill-commit-style',
        name: 'clean-commits',
        description: 'House rules for writing commit messages and splitting commits.',
        body: 'When committing: imperative mood subject under 65 chars; body explains WHY, wrapped at 72; one logical change per commit — split refactors from behavior changes; never commit commented-out code or debug prints.',
      },
    ],
    settings: {
      autoRoute: true, approveDestructive: true, followMode: true,
      shell: 'zsh', defaultCwd: '',
      masterEnabled: false, masterModel: 'claude-sonnet-5', monitorModel: 'claude-haiku-4-5-20251001', apiKey: '',
      provider: 'anthropic', baseUrl: '',
      awsRegion: 'us-east-1', awsProfile: '', awsRefreshCmd: '', credCmd: '',
      registryUrl: 'https://raw.githubusercontent.com/xuancanh/yaam/main/registry/index.json',
      registries: [{ name: 'yaam', url: 'https://raw.githubusercontent.com/xuancanh/yaam/main/registry/index.json' }],
      pluginRegistries: [{ name: 'claude-plugins-official', url: 'https://github.com/anthropics/claude-plugins-official' }],
    },
    // Master's global tools — permissions here gate its tool executor.
    // Auto: act freely · Ask first: confirm in chat first · Approval/Off: blocked.
    toolsCatalog: [
      { id: 'launch_session', name: 'Launch session', desc: 'Master may spawn new CLI sessions.', perm: 'Auto', agents: 0 },
      { id: 'send_to_session', name: 'Send input', desc: 'Master may write to a session\'s terminal (per-session override in the session panel).', perm: 'Auto', agents: 0 },
      { id: 'stop_session', name: 'Stop session', desc: 'Master may kill running sessions.', perm: 'Ask first', agents: 0 },
      { id: 'create_schedule', name: 'Create schedule', desc: 'Master may add recurring cron schedules.', perm: 'Auto', agents: 0 },
      { id: 'add_task', name: 'Add board task', desc: 'Master may add cards to the task board.', perm: 'Auto', agents: 0 },
      { id: 'configure_setting', name: 'Change settings', desc: 'Master may change app settings from chat (never API keys).', perm: 'Auto', agents: 0 },
      { id: 'set_tool_permission', name: 'Change permissions', desc: 'Master may change its own tool permissions.', perm: 'Ask first', agents: 0 },
      { id: 'create_addon', name: 'Build addons', desc: 'Master may create custom tabs (sandboxed HTML addons).', perm: 'Auto', agents: 0 },
    ],
  }
}
