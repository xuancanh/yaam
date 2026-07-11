// DOM helpers for vanilla (non-React) views — the typed port of the classic
// toolkit/sdk.js helpers. React views usually only need `banner` (the default
// `guard` error sink).

let bannerTimer: ReturnType<typeof setTimeout> | undefined

/** Show the error strip at the top of the view (auto-hides after 7s).
 *  Call with no message to hide it. Style `#yaam-banner` in your CSS. */
export function banner(message?: string): void {
  let b = document.getElementById('yaam-banner')
  if (!b) {
    b = document.createElement('div')
    b.id = 'yaam-banner'
    document.body.prepend(b)
  }
  if (!message) { b.style.display = 'none'; return }
  b.textContent = /permission "/.test(message)
    ? `${message} — grant it in the Addons view, then retry.`
    : message
  b.style.display = 'block'
  clearTimeout(bannerTimer)
  bannerTimer = setTimeout(() => { b.style.display = 'none' }, 7000)
}

/** Escape text for innerHTML. ALWAYS use on session names, task titles, and
 *  any other text that originates outside the addon. */
export function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

/** Relative timestamp: "just now" / "3m ago" / "2h ago" / "5d ago". */
export function ago(epochMs: number): string {
  const s = (Date.now() - epochMs) / 1000
  return s < 90 ? 'just now'
    : s < 3600 ? `${Math.round(s / 60)}m ago`
    : s < 86400 ? `${Math.round(s / 3600)}h ago`
    : `${Math.round(s / 86400)}d ago`
}

type ElAttrs = Record<string, string | number | boolean | Partial<CSSStyleDeclaration> | ((e: Event) => void)>
type ElChild = Node | string | null | undefined | ElChild[]

/** Tiny DOM builder: `el('button', { class: 'primary', onclick: fn }, 'Run')`. */
export function el(tag: string, attrs?: ElAttrs, ...children: ElChild[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k.startsWith('on') && typeof v === 'function') (node as unknown as Record<string, unknown>)[k] = v
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else node.setAttribute(k, String(v))
  }
  const append = (c: ElChild): void => {
    if (c == null) return
    if (Array.isArray(c)) { c.forEach(append); return }
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  children.forEach(append)
  return node
}

/** Two-click confirm for destructive actions — modals are blocked in the
 *  sandbox. First click arms the button ("sure? click again"); a second
 *  click within 2.5s runs the action. */
export function confirmClick(button: HTMLElement, action: () => void, label?: string): void {
  if (button.dataset.armed && Date.now() - Number(button.dataset.armed) < 2500) {
    delete button.dataset.armed
    button.textContent = button.dataset.orig ?? button.textContent
    action()
    return
  }
  button.dataset.armed = String(Date.now())
  button.dataset.orig = button.textContent ?? ''
  button.textContent = label ?? 'sure? click again'
  setTimeout(() => {
    if (button.dataset.armed) {
      delete button.dataset.armed
      button.textContent = button.dataset.orig ?? ''
    }
  }, 2600)
}
