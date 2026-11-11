// One sandboxed addon view: the icon-rail tab, a panel docked in a session
// pane, and the popup all host the view through this. Each frame keeps its
// own bridge: state pushes gated by state:read, RPC through the permission-
// enforced API, and a `yaam:context` message saying where it is shown.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useActions } from '../../store'
import { useAppStore } from '../../core/store'
import { withViewCsp } from './view-csp'
import { isTauri, previewClear, previewStash } from '../../core/native'
import { addonSnapshot } from '../../core/addons'
import type { Addon, AddonViewContext } from '../../core/entities'

export function AddonFrame({ addon, context, style }: { addon: Addon; context: AddonViewContext; style?: CSSProperties }) {
  const { addonRpc } = useActions()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const html = addon.html
  const contextRef = useRef(context)
  contextRef.current = context

  // Serve from the yaampreview origin: a srcdoc iframe INHERITS the app's
  // strict CSP (script-src 'self'), which blocks every inline <script> an
  // addon ships. The custom scheme gives the document its own policy
  // container, where the prepended VIEW_CSP meta governs instead. Browser
  // builds have no scheme and fall back to srcDoc (views degrade there).
  const [viewUrl, setViewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!html) { setViewUrl(null); return }
    let alive = true
    let stashedId: string | null = null
    void previewStash(withViewCsp(html)).then(res => {
      if (!res) return
      if (!alive) { void previewClear(res.id); return }
      stashedId = res.id
      setViewUrl(res.url)
    })
    return () => {
      alive = false
      if (stashedId) void previewClear(stashedId)
      setViewUrl(null)
    }
  }, [html])

  const post = (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, '*')

  // Push the latest snapshot, only while the addon holds state:read.
  const push = useCallback(() => {
    const st = useAppStore.getState()
    const a = st.addons.find(x => x.id === addon.id)
    const allowed = !!a?.enabled && a.granted.includes('state:read')
    post({ type: 'yaam:state', state: allowed ? addonSnapshot(st) : null, denied: allowed ? undefined : 'state:read' })
  }, [addon.id])
  const pushContext = useCallback(() => post({ type: 'yaam:context', context: contextRef.current }), [])

  const ctxKey = JSON.stringify(context)
  useEffect(() => { pushContext() }, [ctxKey, pushContext])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data?.type === 'yaam:getState') push()
      if (e.data?.type === 'yaam:getContext') pushContext()
      if (e.data?.type === 'yaam:call' && typeof e.data.callId === 'string' && typeof e.data.method === 'string') {
        const { callId, method } = e.data
        const args = Array.isArray(e.data.args) ? e.data.args : []
        addonRpc(addon.id, method, args).then(result => {
          post({ type: 'yaam:result', callId, result })
        }).catch(err => {
          post({ type: 'yaam:result', callId, error: err instanceof Error ? err.message : String(err) })
        })
      }
    }
    window.addEventListener('message', onMessage)
    const timer = window.setInterval(push, 3000)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(timer)
    }
  }, [addon.id, addonRpc, push, pushContext])

  if (!html) return null
  return (
    <iframe
      ref={iframeRef}
      key={addon.id + addon.createdAt}
      title={addon.name}
      sandbox="allow-scripts"
      {...(viewUrl ? { src: viewUrl } : isTauri ? {} : { srcDoc: withViewCsp(html) })}
      onLoad={() => { push(); pushContext() }}
      style={{ flex: 1, border: 'none', background: 'var(--bg2)', ...style }}
    />
  )
}
