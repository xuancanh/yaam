// What deserves a lock-screen alert, derived from the same snapshot the phone
// renders. Each candidate has a key that is stable for as long as the
// condition lasts, so an alert fires once when the condition APPEARS (not on
// every publish) and re-arms once it clears: a session blocked on the same
// question pings once; answering it and getting blocked again pings again.
import type { RemotePushRequest } from '../../infrastructure/native/remote'
import type { RemoteSnapshot } from './snapshot'

const oneLine = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function pushCandidates(snap: RemoteSnapshot): Map<string, RemotePushRequest> {
  const out = new Map<string, RemotePushRequest>()
  for (const s of snap.sessions) {
    if (s.status === 'needs' || s.actionNeeded) {
      out.set(`needs:s:${s.id}:${s.actionNeeded}`, {
        kind: 'needs',
        title: `${s.name} needs you`,
        body: oneLine(s.actionNeeded || s.nextAction || 'Waiting for your input'),
        tag: `s-${s.id}`,
        open: `session:${s.id}`,
      })
    } else if (s.attention) {
      out.set(`done:s:${s.id}`, {
        kind: 'done',
        title: `${s.name} finished`,
        body: oneLine(s.summary || s.task || 'Ready for the next step'),
        tag: `s-${s.id}`,
        open: `session:${s.id}`,
      })
    }
  }
  for (const t of snap.tasks) {
    if (!t.awaitingUser) continue
    out.set(`needs:t:${t.id}`, {
      kind: 'needs',
      title: `Task: ${oneLine(t.title, 80)}`,
      body: oneLine(t.watcherNext || t.watcherNote || 'The watcher has a question for you'),
      tag: `t-${t.id}`,
      open: `task:${t.id}`,
    })
  }
  for (const a of snap.approvals) {
    out.set(`needs:a:${a.id}`, {
      kind: 'needs',
      title: 'Approval needed',
      body: oneLine([a.label, a.detail].filter(Boolean).join(': ')),
      tag: `a-${a.id}`,
      open: a.kind === 'chat' ? `chat:${a.agentId}` : 'inbox',
    })
  }
  // the answer to something the user asked, once the agent is idle: keyed by
  // the question, so a streaming reply or Master's own follow-up event notes
  // never ping again for the same question
  const answered = (msgs: RemoteSnapshot['master']['msgs']) => {
    let q = -1
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { q = i; break }
    if (q < 0) return null
    const reply = msgs.slice(q + 1).reverse().find(x => x.role === 'assistant' && x.text.trim())
    return reply ? { question: msgs[q].id, text: reply.text } : null
  }
  const m = !snap.master.busy && answered(snap.master.msgs)
  if (m) {
    out.set(`done:m:${m.question}`, { kind: 'done', title: 'Master replied', body: oneLine(m.text), tag: 'master', open: 'master' })
  }
  for (const c of snap.chats) {
    const r = !c.busy && answered(c.msgs)
    if (r) out.set(`done:c:${c.id}:${r.question}`, { kind: 'done', title: c.name, body: oneLine(r.text), tag: `c-${c.id}`, open: `chat:${c.id}` })
  }
  return out
}

/** Alerts for conditions that appeared since `prev` (the previous keys). */
export function newAlerts(prev: ReadonlySet<string>, cur: Map<string, RemotePushRequest>): RemotePushRequest[] {
  const fresh: RemotePushRequest[] = []
  for (const [k, v] of cur) if (!prev.has(k)) fresh.push(v)
  return fresh
}
