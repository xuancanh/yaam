// CodeMirror is the heaviest UI dependency — load it only when a file is
// actually opened for editing, so the main bundle stays lean.
import { Suspense, lazy } from 'react'
import type { ComponentProps } from 'react'

const Editor = lazy(() => import('./CodeEditor').then(m => ({ default: m.CodeEditor })))

export function CodeEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense fallback={<div style={{ padding: 18, fontSize: 12, color: 'var(--dim)' }}>Loading editor…</div>}>
      <Editor {...props} />
    </Suspense>
  )
}
