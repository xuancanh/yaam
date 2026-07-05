// Typed telemetry / event service. Silent `.catch(() => {})` and bare console
// logs make lifecycle, persistence, and policy failures hard to diagnose. This
// gives them one structured channel: a bounded in-memory ring plus subscribers,
// with domain/severity/actor/correlation fields. Warn+error also mirror to the
// console so nothing is swallowed. Zero framework coupling.
export type Severity = 'debug' | 'info' | 'warn' | 'error'

export interface TelemetryEvent {
  /** epoch ms */
  at: number
  severity: Severity
  /** owning subsystem: 'commands' | 'persistence' | 'session' | 'chat' | … */
  domain: string
  message: string
  /** actor kind that triggered it, when applicable (user/master/addon/…) */
  actor?: string
  sessionId?: string
  taskId?: string
  /** ties related events together (e.g. one command execution) */
  correlationId?: string
  /** structured extras (never a secret) */
  detail?: Record<string, unknown>
}

export type TelemetryInput = Omit<TelemetryEvent, 'at'>

export interface Telemetry {
  emit: (event: TelemetryInput) => void
  /** observe events; returns an unsubscribe fn */
  subscribe: (fn: (event: TelemetryEvent) => void) => () => void
  /** most recent events, newest last (bounded) */
  recent: () => readonly TelemetryEvent[]
}

const RING_CAP = 500

export function createTelemetry(opts: { mirrorToConsole?: boolean } = {}): Telemetry {
  const mirror = opts.mirrorToConsole ?? true
  const ring: TelemetryEvent[] = []
  const listeners = new Set<(e: TelemetryEvent) => void>()
  return {
    emit: input => {
      const event: TelemetryEvent = { at: Date.now(), ...input }
      ring.push(event)
      if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
      if (mirror && (event.severity === 'warn' || event.severity === 'error')) {
        const line = `[yaam:${event.domain}] ${event.message}`
        if (event.severity === 'error') console.error(line, event.detail ?? '')
        else console.warn(line, event.detail ?? '')
      }
      for (const l of [...listeners]) {
        try { l(event) } catch { /* a bad subscriber must not break emit */ }
      }
    },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    recent: () => ring,
  }
}

/** Process-wide default telemetry sink. */
export const telemetry: Telemetry = createTelemetry()
