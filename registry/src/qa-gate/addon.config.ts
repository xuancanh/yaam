import { defineAddon } from 'yaam-addon'

export default defineAddon({
  name: 'QA Gate',
  version: '1.0.1',
  icon: '✅',
  description: 'Independent QA audits for board tasks — every task that reaches review gets a one-shot auditor session that re-verifies the acceptance criteria and reports its verdict to the task chat. Failing tasks bounce back to In progress.',
  author: 'yaam',
  permissions: ['state:read', 'tasks', 'sessions:launch', 'sessions:send', 'schedules', 'agent', 'master:prompt', 'ui', 'storage'],
  view: 'index.html',
  tools: [
    {
      name: 'qa_history',
      description: 'QA Gate audit history — the pass/fail record of review-gate audits.',
      input: { limit: 'number · max entries to return (default 10)' },
      handler: 'src/tools/qa_history.ts',
    },
    {
      name: 'qa_audit_task',
      description: 'Run an independent QA audit for a board task right now (spawns an auditor one-shot that re-verifies the acceptance criteria without modifying files).',
      input: { task_id: 'string! · id of the board task to audit' },
      handler: 'src/tools/qa_audit_task.ts',
    },
  ],
  hooks: {
    onTaskMoved: 'src/hooks/onTaskMoved.ts',
    onSessionExit: 'src/hooks/onSessionExit.ts',
  },
  masterPromptAppend: 'prompts/master.md',
  agent: {
    system: 'prompts/agent.md',
    on: ['onSessionExit'],
  },
})
