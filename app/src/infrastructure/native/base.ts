// Shared base for the native capability adapters: the single Tauri-presence flag.
// In a plain browser build (e.g. `npm run dev` opened directly) the adapters fall
// back to deliberate no-ops / localStorage so the simulated app still works.
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
