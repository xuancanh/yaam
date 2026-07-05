import { useState } from 'react'
import { highlight } from '../../core/highlight'
import { useActions } from '../../store'
import type { Addon } from '../../types'

// ---------- editor-style code block ----------

/** Render highlighted addon source with an independent copy action. */
function CodeBlock({ title, lang, code }: { title: string; lang: 'js' | 'html' | 'json' | 'text'; code: string }) {
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = useState(code.split('\n').length > 40)
  const lines = code.split('\n')
  const shown = collapsed ? lines.slice(0, 24) : lines

  // Copy this block and briefly expose completion feedback.
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    }).catch(() => {})
  }

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 11, overflow: 'hidden', background: '#07080B' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px',
        background: 'var(--panel)', borderBottom: '1px solid var(--line)',
      }}>
        <span style={{ display: 'flex', gap: 5 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#2C313B' }} />
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#2C313B' }} />
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#2C313B' }} />
        </span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase' }}>{lang}</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>{lines.length} lines</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', padding: '2px 10px', fontSize: 10.5 }} onClick={copy}>
          {copied ? '✓ copied' : 'Copy'}
        </button>
      </div>
      <div style={{ display: 'flex', overflowX: 'auto' }}>
        <div className="mono" aria-hidden style={{
          padding: '10px 0', textAlign: 'right', userSelect: 'none', flexShrink: 0,
          color: 'var(--faint)', fontSize: 11.5, lineHeight: 1.65, minWidth: 44,
          borderRight: '1px solid #14171d', paddingRight: 10, background: '#0A0B0F',
        }}>
          {shown.map((_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <pre
          className="mono"
          style={{
            margin: 0, padding: '10px 16px', fontSize: 11.5, lineHeight: 1.65,
            color: '#C7CCD6', userSelect: 'text', cursor: 'text', whiteSpace: 'pre', flex: 1,
          }}
          dangerouslySetInnerHTML={{ __html: highlight(shown.join('\n'), lang) }}
        />
      </div>
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          style={{
            width: '100%', padding: 7, background: 'var(--panel)', border: 'none',
            borderTop: '1px solid var(--line)', color: 'var(--accent)', fontSize: 11.5, fontWeight: 600,
          }}
        >
          Show all {lines.length} lines
        </button>
      )}
    </div>
  )
}

// ---------- manifest form + sections ----------

const FIELD = {
  background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
} as const

/** Group related addon package fields under a compact section label. */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.5, color: 'var(--mut)', marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
    </div>
  )
}

/** Present an installed addon's manifest, view, tools, and hooks as source. */
export function AddonSource({ addon }: { addon: Addon }) {
  const { updateAddonMeta } = useActions()
  // Render one editable-looking manifest metadata cell from the installed addon.
  const meta = (key: 'name' | 'version' | 'icon' | 'desc' | 'author', label: string, width: number) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>{label}</span>
      <input
        value={addon[key] ?? ''}
        onChange={e => updateAddonMeta(addon.id, { [key]: e.target.value })}
        style={{ ...FIELD, width }}
      />
    </label>
  )

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#0A0B0F', padding: '20px 24px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>

        <Section label="MANIFEST">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 11, padding: 14 }}>
            {meta('name', 'name', 180)}
            {meta('version', 'version', 80)}
            {meta('icon', 'icon', 56)}
            {meta('author', 'author', 140)}
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 220 }}>
              <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>description</span>
              <input
                value={addon.desc ?? ''}
                onChange={e => updateAddonMeta(addon.id, { desc: e.target.value })}
                style={{ ...FIELD, width: '100%' }}
              />
            </label>
          </div>
        </Section>

        {addon.html && (
          <Section label="VIEW">
            <CodeBlock title="view.html" lang="html" code={addon.html} />
          </Section>
        )}

        {addon.tools?.length ? (
          <Section label={`MASTER TOOLS (${addon.tools.length})`}>
            {addon.tools.map(t => (
              <div key={t.name} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
                  <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>addon_{t.name}</span>
                  {t.description ? ` — ${t.description}` : ''}
                </div>
                <CodeBlock title={`${t.name} · handler(input, api)`} lang="js" code={t.handler} />
                <CodeBlock title={`${t.name} · input_schema`} lang="json" code={JSON.stringify(t.input_schema, null, 2)} />
              </div>
            ))}
          </Section>
        ) : null}

        {addon.hooks && (
          <Section label="HOOKS">
            {addon.hooks.onSessionExit && <CodeBlock title="onSessionExit(event, api)" lang="js" code={addon.hooks.onSessionExit} />}
            {addon.hooks.onNeedsInput && <CodeBlock title="onNeedsInput(event, api)" lang="js" code={addon.hooks.onNeedsInput} />}
            {addon.hooks.masterPromptAppend && <CodeBlock title="masterPromptAppend" lang="text" code={addon.hooks.masterPromptAppend} />}
          </Section>
        )}

        <div style={{ fontSize: 11.5, color: 'var(--dim)', lineHeight: 1.6, paddingBottom: 8 }}>
          Manifest fields save as you type. To change the code, use the <span style={{ color: 'var(--accent)' }}>Customize</span> tab
          — describe the change and the editor rewrites the package — or Export, edit the JSON, and re-install.
        </div>
      </div>
    </div>
  )
}
