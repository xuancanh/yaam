// Shared hook body (wired to all four hooks in addon.yaml). Hooks receive
// (input = the event, api = the permission-scoped AddonApi) and run in the
// sandbox — every api method except getState is async, so ALWAYS await.
// This one just records the event so the view's "Hook log" section can show
// hooks firing in real time.
const log = (await api.storage.get('hookLog')) || []
log.unshift({ at: Date.now(), event: input })
await api.storage.set('hookLog', log.slice(0, 100))
