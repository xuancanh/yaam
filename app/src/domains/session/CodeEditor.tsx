// Real code editing for the file viewer and the git workbench: CodeMirror 6
// with lazy language support, ⌘S/Ctrl+S save through the session's fs adapter
// (local native or SSH), dirty tracking, and a save bar. The host decides where
// the edited file lives and how to refresh after a save.
import { useEffect, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { keymap } from '@codemirror/view'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'

/** CodeMirror language extension for a filename, resolved lazily. */
async function languageFor(name: string) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const desc = languages.find(l => l.extensions.includes(ext))
    ?? languages.find(l => l.name.toLowerCase() === ext)
  return desc ? await desc.load() : null
}

// Wrapped in Prec.high so these rules beat oneDark's own colors (earlier /
// higher-precedence extensions win in CodeMirror) — otherwise the editor sits
// on oneDark's blue-gray #282c34, a hazy mismatched slab inside the app's
// near-black chrome.
const baseTheme = Prec.high(EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--bg3)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--bg2)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line-soft)' },
  '.cm-activeLine': { backgroundColor: 'rgba(245,196,81,.04)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--mut)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderTop: '1px solid var(--line)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'inherit' },
  '&.cm-focused': { outline: 'none' },
}))

export function CodeEditor({ path, initial, baseline, onSave, onClose, onDocChange }: {
  path: string
  initial: string
  /** the text considered "saved" for dirty tracking — defaults to `initial`.
   *  Differs from it when the host restores an unsaved draft over the disk
   *  snapshot, so the editor opens already dirty. */
  baseline?: string
  /** persist the buffer (fs adapter write); throw to surface the error */
  onSave: (text: string) => Promise<void>
  /** leave the editor (host returns to its viewer) */
  onClose: () => void
  /** fired on every doc change (and after a save) with the current text and
   *  whether it differs from the saved baseline — hosts mirror this into
   *  per-tab draft state */
  onDocChange?: (text: string, dirty: boolean) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [note, setNote] = useState<string | null>(null)
  const savedRef = useRef(baseline ?? initial)
  const onDocChangeRef = useRef(onDocChange)
  onDocChangeRef.current = onDocChange

  const save = async () => {
    const view = viewRef.current
    if (!view || busyRef.current) return
    const text = view.state.doc.toString()
    busyRef.current = true
    setBusy(true)
    setNote(null)
    try {
      await onSave(text)
      if (viewRef.current === view) {
        savedRef.current = text
        const nowDirty = view.state.doc.toString() !== text
        setDirty(nowDirty)
        onDocChangeRef.current?.(view.state.doc.toString(), nowDirty)
        setNote('saved')
        window.setTimeout(() => {
          if (viewRef.current === view) setNote(null)
        }, 1800)
      }
    } catch (e) {
      if (viewRef.current === view) setNote(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const langCompartment = new Compartment()
    const theme = document.documentElement.getAttribute('data-theme')
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { void saveRef.current(); return true } },
            indentWithTab,
          ]),
          langCompartment.of([]),
          ...(theme === 'light' || theme === 'paper' ? [] : [oneDark]),
          baseTheme,
          EditorView.updateListener.of(u => {
            if (u.docChanged) {
              const text = u.state.doc.toString()
              const nowDirty = text !== savedRef.current
              setDirty(nowDirty)
              onDocChangeRef.current?.(text, nowDirty)
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    savedRef.current = baseline ?? initial
    setDirty(view.state.doc.toString() !== savedRef.current)
    void languageFor(path.slice(path.lastIndexOf('/') + 1)).then(lang => {
      if (lang && viewRef.current === view) view.dispatch({ effects: langCompartment.reconfigure(lang) })
    })
    view.focus()
    return () => {
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // Same-file prop refreshes can follow a save. Keep the live buffer intact;
    // opening another path (or remounting this editor) loads a fresh snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg3)' }}>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
      <div style={{
        height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px',
        background: 'var(--panel)', borderTop: '1px solid var(--line)',
      }}>
        <span className="mono" style={{ fontSize: 10.5, color: dirty ? 'var(--amber)' : 'var(--dim)' }}>
          {dirty ? '● unsaved changes' : 'no changes'}
        </span>
        {note && (
          <span className="mono" style={{ fontSize: 10.5, color: note === 'saved' ? 'var(--green)' : 'var(--red-soft)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {note}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="deny-btn" style={{ padding: '5px 13px', fontSize: 11.5 }} onClick={onClose}>
          {dirty ? 'Discard & close' : 'Close editor'}
        </button>
        <button
          className="approve-btn"
          style={{ padding: '5px 16px', fontSize: 11.5, opacity: dirty && !busy ? 1 : 0.5 }}
          disabled={!dirty || busy}
          title="Save (⌘S)"
          onClick={() => { void save() }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
