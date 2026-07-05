import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

/** Draft-editing bindings for a text field: it edits a local draft and commits
 *  to the store only on blur or Enter, so typing a settings value no longer
 *  dispatches (and persists) global state on every keystroke. Escape reverts.
 *  Re-syncs from `value` when the prop changes and the field isn't being edited. */
function useDraft(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value)
  const editing = useRef(false)
  // Last value we committed / synced, so a commit-then-blur (Enter) doesn't fire
  // onCommit twice and an unchanged field never dispatches at all.
  const committed = useRef(value)
  useEffect(() => {
    if (!editing.current) { setDraft(value); committed.current = value }
  }, [value])

  const commit = () => {
    editing.current = false
    if (draft !== committed.current) { committed.current = draft; onCommit(draft) }
  }
  return {
    value: draft,
    onFocus: () => { editing.current = true },
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: { key: string; currentTarget: { blur: () => void } }) => {
      // Enter commits single-line fields; Shift+Enter is left to the textarea for newlines.
      if (e.key === 'Enter') { commit(); e.currentTarget.blur() }
      else if (e.key === 'Escape') { setDraft(committed.current); editing.current = false; e.currentTarget.blur() }
    },
  }
}

type InputPass = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onFocus' | 'onKeyDown' | 'style'>

/** Single-line text input backed by a local draft (commits on blur/Enter). */
export function DraftInput({
  value,
  onCommit,
  style,
  ...rest
}: InputPass & { value: string; onCommit: (next: string) => void; style?: CSSProperties }) {
  const bind = useDraft(value, onCommit)
  return <input {...rest} style={style} {...bind} />
}

type AreaPass = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'onBlur' | 'onFocus' | 'onKeyDown' | 'style'>

/** Multi-line textarea backed by a local draft. Enter inserts newlines as usual;
 *  it commits on blur only (no Enter-to-commit, so multi-line editing works). */
export function DraftTextarea({
  value,
  onCommit,
  style,
  ...rest
}: AreaPass & { value: string; onCommit: (next: string) => void; style?: CSSProperties }) {
  const bind = useDraft(value, onCommit)
  return (
    <textarea
      {...rest}
      style={style}
      value={bind.value}
      onFocus={bind.onFocus}
      onChange={bind.onChange}
      onBlur={bind.onBlur}
      onKeyDown={e => { if (e.key === 'Escape') { bind.onKeyDown(e) } }}
    />
  )
}
