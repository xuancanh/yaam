// Floating actions for text selected in a terminal: ask an agent about it
// (this session or another one in the workspace, a handoff), file it as a
// board task, or copy it. Appears while a selection exists.
import { useEffect, useRef, useState } from 'react'
import { useActions, useConductorSelector } from '../../store'
import { getTerminal } from '../../core/terminals'
import type { Agent } from '../../core/types'
import { selectionPrompt, taskFromSelection } from './prompt-compose'

const BTN = { fontSize: 11.5, fontWeight: 600, padding: '4px 9px', borderRadius: 6, border: '1px solid var(--line2)', background: 'var(--panel2)', color: 'var(--text)', cursor: 'pointer' } as const

export function SelectionBar({ agent }: { agent: Agent }) {
  const [sel, setSel] = useState('')
  const [composer, setComposer] = useState<{ text: string } | null>(null)
  const [note, setNote] = useState('')
  const [target, setTarget] = useState(agent.id)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const { sendPrompt, createTask, focusTab } = useActions()
  // peers a selection can be handed to: live terminal sessions of this workspace
  const peerKey = useConductorSelector(x => {
    const ws = agent.workspaceId ?? x.activeWorkspace
    return x.agents
      .filter(a => !a.archived && a.kind !== 'chat' && (a.workspaceId ?? x.activeWorkspace) === ws && (a.status === 'running' || a.status === 'needs'))
      .map(a => `${a.id}\t${a.name}`).join('\n')
  })
  const peers = peerKey ? peerKey.split('\n').map(l => { const [id, name] = l.split('\t'); return { id, name } }) : []

  useEffect(() => {
    const term = getTerminal(agent.id).term
    const sub = term.onSelectionChange(() => setSel(term.getSelection()))
    return () => sub.dispose()
  }, [agent.id])

  const open = () => {
    setComposer({ text: sel })
    setTarget(agent.id)
    setNote('')
    requestAnimationFrame(() => noteRef.current?.focus())
  }
  const send = () => {
    if (!composer) return
    const to = peers.find(p => p.id === target) ? target : agent.id
    sendPrompt(to, selectionPrompt(composer.text, note, { name: agent.name, same: to === agent.id }),
      to === agent.id ? 'Asked about selected output' : `Handed output over from ${agent.name}`)
    setComposer(null)
    getTerminal(agent.id).term.clearSelection()
    if (to !== agent.id) focusTab(to)
  }

  if (composer) {
    return (
      <div onMouseDown={e => e.stopPropagation()} style={{
        position: 'absolute', right: 14, bottom: 12, zIndex: 6, width: 'min(420px, calc(100% - 28px))',
        background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 10, padding: 10,
        boxShadow: '0 10px 30px rgba(0,0,0,.4)', display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', maxHeight: 54, overflow: 'hidden', whiteSpace: 'pre-wrap', borderLeft: '2px solid var(--line2)', paddingLeft: 8 }}>
          {composer.text.trim().slice(0, 300)}
        </div>
        <textarea
          ref={noteRef}
          value={note}
          onChange={e => setNote(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send() }
            if (e.key === 'Escape') setComposer(null)
          }}
          rows={2}
          placeholder="What should the agent do with this? (Enter sends)"
          style={{ resize: 'none', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 7, padding: '7px 9px', color: 'var(--text)', fontSize: 12.5, outline: 'none', fontFamily: 'var(--font-sans)' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>Send to</span>
          <select value={target} onChange={e => setTarget(e.target.value)} style={{ flex: 1, minWidth: 0, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '4px 6px' }}>
            <option value={agent.id}>{agent.name} (this session)</option>
            {peers.filter(p => p.id !== agent.id).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button style={{ ...BTN, background: 'var(--accent)', color: '#1a1300', borderColor: 'var(--accent)' }} onClick={send}>Send</button>
          <button style={BTN} onClick={() => setComposer(null)}>Cancel</button>
        </div>
      </div>
    )
  }

  if (sel.trim().length < 2) return null
  return (
    <div onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} style={{
      position: 'absolute', right: 14, bottom: 12, zIndex: 6, display: 'flex', gap: 5, padding: 4,
      background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 9, boxShadow: '0 6px 20px rgba(0,0,0,.35)',
    }}>
      <button style={BTN} title="Ask this session (or hand it to another one) about the selected output" onClick={open}>Ask about this…</button>
      <button style={BTN} title="Create a board task from the selected output" onClick={() => {
        createTask(taskFromSelection(sel, { name: agent.name, cwd: agent.cwd }))
        getTerminal(agent.id).term.clearSelection()
      }}>→ Task</button>
      <button style={BTN} title="Copy the selection" onClick={() => { void navigator.clipboard?.writeText(sel); getTerminal(agent.id).term.clearSelection() }}>Copy</button>
    </div>
  )
}
