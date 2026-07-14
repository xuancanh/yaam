// Compatibility barrel for the native bridge. The implementations now live in
// capability-scoped adapters under infrastructure/native/* (session, http,
// filesystem, mcp, search, bedrock, git, persistence, secrets). This file
// re-exports them so existing `core/native` imports keep working; new code may
// import the specific capability adapter directly. Browser fallbacks are
// deliberate no-ops/localStorage in each adapter, not a mix scattered here.
export { isTauri } from '../infrastructure/native/base'
export * from '../infrastructure/native/base'
export * from '../infrastructure/native/session'
export * from '../infrastructure/native/http'
export * from '../infrastructure/native/filesystem'
export * from '../infrastructure/native/mcp'
export * from '../infrastructure/native/search'
export * from '../infrastructure/native/bedrock'
export * from '../infrastructure/native/git'
export * from '../infrastructure/native/worktree'
export * from '../infrastructure/native/sandbox'
export * from '../infrastructure/native/remote'
export * from '../infrastructure/native/icons'
export * from '../infrastructure/native/preview'
export * from '../infrastructure/native/detach'
export * from '../infrastructure/native/persistence'
export * from '../infrastructure/native/secrets'
export * from '../infrastructure/native/notify'
