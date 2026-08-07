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
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/** CodeMirror language extension for a filename, resolved lazily. */
async function languageFor(name: string) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const desc = languages.find(l => l.extensions.includes(ext))
    ?? languages.find(l => l.name.toLowerCase() === ext)
  return desc ? await desc.load() : null
}

// Everything reads app CSS variables, so the editor restyles live with the
// theme and the Settings → Appearance viewer palette — no oneDark, whose fixed
// blue-gray background used to sit as a hazy mismatched slab in the chrome.
// Prec.high keeps these rules above any language/extension defaults.
const baseTheme = Prec.high(EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--bg3)', color: 'var(--text2)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--bg2)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line-soft)' },
  '.cm-activeLine': { backgroundColor: 'rgba(128,128,128,.07)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--mut)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(128,128,128,.18)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderTop: '1px solid var(--line)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'inherit' },
  '&.cm-focused': { outline: 'none' },
}))

// Token colors from the shared --hl-* variables (same source as the read-only
// viewer's regex highlighter), so both surfaces always agree.
const varHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [t.comment, t.blockComment, t.lineComment], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string), t.regexp, t.docString], color: 'var(--hl-string)' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.bool, t.null, t.self], color: 'var(--hl-keyword)' },
  { tag: [t.number, t.integer, t.float, t.atom], color: 'var(--hl-number)' },
  { tag: [t.typeName, t.tagName, t.className, t.namespace], color: 'var(--hl-tag)' },
  { tag: [t.attributeName, t.propertyName, t.labelName], color: 'var(--hl-attr)' },
  { tag: [t.heading], color: 'var(--text)', fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--hl-tag)', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
]))

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
          varHighlight,
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
