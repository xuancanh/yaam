import type { HandlerApi } from '@yaam/addon-sdk'

export interface AlertConfig {
  via: 'ntfy' | 'telegram'
  /** ntfy topic: anyone who knows it can read it, so make it long and random */
  topic?: string
  chatId?: string
  needsInput: boolean
  finished: boolean
  failed: boolean
  /** epoch ms until which alerts are muted */
  muteUntil?: number
}

export const DEFAULTS: AlertConfig = { via: 'ntfy', needsInput: true, finished: false, failed: true }

export async function loadConfig(api: HandlerApi): Promise<AlertConfig> {
  return { ...DEFAULTS, ...((await api.storage.get('config')) as Partial<AlertConfig> | null ?? {}) }
}

/** Send one alert. Returns a short status for the caller to show. */
export async function sendAlert(api: HandlerApi, cfg: AlertConfig, title: string, body: string, urgent = false): Promise<string> {
  const secrets = await api.secrets.list()
  const has = (n: string) => secrets.some(s => s.name === n && s.set)
  if (cfg.via === 'telegram') {
    if (!has('TELEGRAM_BOT_TOKEN') || !cfg.chatId) return 'Telegram needs the TELEGRAM_BOT_TOKEN secret and a chat id'
    const r = await api.http.request('POST', 'https://api.telegram.org/bot{{secret:TELEGRAM_BOT_TOKEN}}/sendMessage', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: `${title}\n${body}`.slice(0, 3500), disable_notification: !urgent }),
    })
    return r.status < 300 ? 'sent via Telegram' : `Telegram answered ${r.status}: ${r.text.slice(0, 120)}`
  }
  const topic = (cfg.topic ?? '').trim()
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(topic)) return 'set an ntfy topic first (6-64 letters, digits, - or _)'
  const headers: Record<string, string> = { Title: title.slice(0, 120), Priority: urgent ? '4' : '3', Tags: urgent ? 'warning' : 'white_check_mark' }
  if (has('NTFY_TOKEN')) headers.Authorization = 'Bearer {{secret:NTFY_TOKEN}}'
  const r = await api.http.request('POST', `https://ntfy.sh/${topic}`, { headers, body: body.slice(0, 3500) })
  return r.status < 300 ? 'sent via ntfy' : `ntfy answered ${r.status}: ${r.text.slice(0, 120)}`
}

export const muted = (cfg: AlertConfig) => Boolean(cfg.muteUntil && cfg.muteUntil > Date.now())
