// A task's prompt has two layers that must not be mixed into one blob: the
// WORK TEXT (fills a template's {task} slot) and the CONTRACT (criteria + goal
// stop-condition, appended after the composed prompt).

/** the work item itself: title + description — fills a template's {task} slot */
export function taskWorkText(task: { title: string; description?: string }): string {
  return [task.title, task.description].filter(Boolean).join('\n\n')
}

/** verification contract appended after any template framing: acceptance
 *  criteria plus /goal-style stop-condition semantics. */
export function taskContract(task: { criteria?: string[] }): string {
  const criteria = task.criteria ?? []
  if (!criteria.length) return ''
  return `Acceptance criteria:\n${criteria.map(c => `- ${c}`).join('\n')}\n\n` +
    'GOAL — treat the acceptance criteria above as your stop condition. They override any earlier instruction about when to stop. Before finishing, re-verify each criterion against your actual changes and outputs; if any is unmet, keep working until it is. If something genuinely blocks you, stop and state precisely what is blocking and what you completed.'
}
