// YAAM addon view SDK.
//
// Inline it into your view with an @include marker inside a <script> block
// (see toolkit/README.md) — resolved at install/pack time, because the
// sandbox CSP forbids external resources; there is no <script src>.
/*
 * It defines one global, `yaam`:
 *
 *   yaam.call('tasks.add', 'title', 'backlog', {...})  // raw dotted RPC → Promise
 *   yaam.api.tasks.add('title', 'backlog', {...})      // same, as a proxy tree
 *   yaam.onState(state => render(state))               // live snapshot pushes (~3s)
 *   yaam.banner('something went wrong')                // error strip (auto-hides)
 *   yaam.guard(promise)                                // await + banner on rejection
 *   yaam.esc(text) · yaam.ago(ts) · yaam.el(...)       // small view helpers
 *   yaam.confirm(button, () => doIt())                 // two-click confirm (no modals!)
 *
 * Every api method needs its permission granted in the Addons view; denied
 * calls reject with `permission "…" not granted` — yaam.guard surfaces those.
 */
'use strict'
const yaam = (() => {
  let seq = 0
  const pending = {}
  const stateSubs = []
  let lastState = null

  function call(method, ...args){
    return new Promise((resolve, reject) => {
      const callId = 'sdk' + (++seq)
      pending[callId] = { resolve, reject }
      parent.postMessage({ type: 'yaam:call', callId, method, args }, '*')
    })
  }

  window.addEventListener('message', e => {
    const d = e.data
    if (!d || typeof d !== 'object') return
    if (d.type === 'yaam:result' && pending[d.callId]) {
      d.error ? pending[d.callId].reject(new Error(d.error)) : pending[d.callId].resolve(d.result)
      delete pending[d.callId]
    }
    if (d.type === 'yaam:state') {
      lastState = d.state
      for (const cb of stateSubs) { try { cb(d.state, d.denied) } catch (err) { console.error(err) } }
    }
  })

  // yaam.api.tasks.add(...) → call('tasks.add', ...)
  const api = new Proxy({}, {
    get: (_t, ns) => new Proxy(() => {}, {
      apply: (_f, _this, args) => call(String(ns), ...args),          // yaam.api.flash('hi')
      get: (_t2, method) => (...args) => call(ns + '.' + String(method), ...args),
    }),
  })

  function banner(msg){
    let b = document.getElementById('yaam-banner')
    if (!b) {
      b = document.createElement('div')
      b.id = 'yaam-banner'
      document.body.prepend(b)
    }
    if (!msg) { b.style.display = 'none'; return }
    b.textContent = /permission "/.test(String(msg))
      ? msg + ' — grant it in the Addons view, then retry.'
      : String(msg)
    b.style.display = 'block'
    clearTimeout(banner._t)
    banner._t = setTimeout(() => { b.style.display = 'none' }, 7000)
  }

  async function guard(promise, fallback){
    try { return await promise } catch (e) { banner(e && e.message || e); return fallback }
  }

  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const ago = t => {
    const s = (Date.now() - t) / 1000
    return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'
  }

  // tiny DOM builder: el('button', {class:'primary', onclick: fn}, 'Run')
  function el(tag, attrs, ...children){
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith('on') && typeof v === 'function') node[k] = v
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
      else node.setAttribute(k === 'class' ? 'class' : k, v)
    }
    for (const c of children.flat()) {
      if (c == null) continue
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return node
  }

  // modals are blocked in the sandbox — destructive actions confirm by
  // arming the button: first click asks, second within 2.5s executes
  function confirm(button, action, label){
    if (button.dataset.armed && Date.now() - Number(button.dataset.armed) < 2500) {
      delete button.dataset.armed
      button.textContent = button.dataset.orig || button.textContent
      action()
      return
    }
    button.dataset.armed = String(Date.now())
    button.dataset.orig = button.textContent
    button.textContent = label || 'sure? click again'
    setTimeout(() => {
      if (button.dataset.armed) {
        delete button.dataset.armed
        button.textContent = button.dataset.orig
      }
    }, 2600)
  }

  function onState(cb){
    stateSubs.push(cb)
    if (lastState) cb(lastState)
    parent.postMessage({ type: 'yaam:getState' }, '*')
    return () => { const i = stateSubs.indexOf(cb); if (i >= 0) stateSubs.splice(i, 1) }
  }

  return { call, api, onState, state: () => lastState, banner, guard, esc, ago, el, confirm }
})()
