// Manifest + source validation, mirroring the host's parseAddonPackage rules
// so problems surface at build time instead of at install.
import { ALL_PERMISSIONS, METHOD_PERMISSION } from '@yaam/addon-sdk'
import type { AddonPermission } from '@yaam/addon-sdk'
import type { AddonConfig } from './config.js'

export interface ValidationIssue {
  level: 'error' | 'warning'
  message: string
}

const HOOK_NAMES = ['onSessionExit', 'onNeedsInput', 'onTaskMoved', 'onCronFired']
const HOST_RE = /^(\*\.)?[a-z0-9.-]+$/i
const SECRET_RE = /^[A-Za-z0-9_]+$/
const CRON_RE = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/

/** Static checks on the config itself. */
export function validateConfig(cfg: AddonConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (message: string) => issues.push({ level: 'error', message })
  const warn = (message: string) => issues.push({ level: 'warning', message })

  if (!cfg.name?.trim()) err('config needs a "name"')
  if (!cfg.version?.trim()) err('config needs a "version"')
  else if (!/^\d+\.\d+\.\d+/.test(cfg.version)) warn(`version "${cfg.version}" is not semver (the registry sorts by it)`)
  if (cfg.icon && [...cfg.icon].length > 2) warn(`icon "${cfg.icon}" is truncated to 2 characters by the host`)
  if (!cfg.description?.trim()) warn('no description — it is the install-time pitch and the registry card text')

  const allIds = ALL_PERMISSIONS.map(p => p.id)
  for (const p of cfg.permissions ?? []) {
    if (!allIds.includes(p)) err(`unknown permission "${p}" (valid: ${allIds.join(', ')})`)
  }
  if (!cfg.permissions) {
    warn('no "permissions" — legacy packages request EVERY scope; declare the ones you use')
  }

  for (const h of cfg.hosts ?? []) {
    if (!HOST_RE.test(h.trim())) err(`host "${h}" is invalid (hostname or *.wildcard, no scheme/path)`)
  }
  for (const s of cfg.secrets ?? []) {
    const name = typeof s === 'string' ? s : s.name
    if (!SECRET_RE.test(name)) err(`secret name "${name}" must match [A-Za-z0-9_]+`)
  }
  if (cfg.secrets?.length && !cfg.permissions?.includes('secrets')) {
    warn('declares secrets but not the "secrets" permission — secrets.list() will be denied')
  }
  if (cfg.hosts?.length && !cfg.permissions?.includes('http')) {
    warn('declares hosts but not the "http" permission — http.request() will be denied')
  }

  for (const k of Object.keys(cfg.hooks ?? {})) {
    if (!HOOK_NAMES.includes(k)) err(`unknown hook "${k}" (valid: ${HOOK_NAMES.join(', ')})`)
  }
  if (cfg.agent?.every && !CRON_RE.test(cfg.agent.every)) {
    err(`agent.every "${cfg.agent.every}" is not a 5-field cron expression`)
  }
  if (cfg.agent && !cfg.permissions?.includes('agent')) {
    warn('ships an agent but not the "agent" permission — agent.wake() will be denied')
  }
  if (!cfg.view && !cfg.tools?.length && !Object.keys(cfg.hooks ?? {}).length && !cfg.agent && !cfg.masterPromptAppend) {
    err('package has no view, tools, hooks, or agent — the host refuses to install it')
  }
  return issues
}

/** Scan handler/tool *source* (pre-bundle) for api calls whose permission the
 *  config does not declare. Heuristic by design: it catches the common case
 *  (`api.tasks.add(…)`, `api.flash(…)`) — the host still enforces at runtime. */
export function scanHandlerPermissions(source: string, declared: AddonPermission[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const m of source.matchAll(/\bapi\s*\.\s*(\w+)(?:\s*\.\s*(\w+))?\s*\(/g)) {
    const method = m[2] ? `${m[1]}.${m[2]}` : m[1]
    const perm = METHOD_PERMISSION[method]
    if (!perm || seen.has(method)) continue
    seen.add(method)
    if (!declared.includes(perm)) {
      issues.push({ level: 'warning', message: `calls api.${method} but does not declare the "${perm}" permission — the call will be denied until the user grants it` })
    }
  }
  return issues
}

/** Guard rails on the built view size (it is inlined into app state). */
export function checkViewSize(html: string): ValidationIssue[] {
  const kb = Math.round(html.length / 1024)
  if (kb > 1500) return [{ level: 'error', message: `view.html is ${kb} KB — over the 1.5 MB budget; trim dependencies (preact/compat?) or assets` }]
  if (kb > 700) return [{ level: 'warning', message: `view.html is ${kb} KB — consider preact/compat or fewer inlined assets` }]
  return []
}
