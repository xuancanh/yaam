import { defineAddon } from 'yaam-addon'

// herdr's agent-telegram-notify, for YAAM: a push to your phone when a session
// is waiting on you or finishes, via ntfy (no account) or a Telegram bot.
export default defineAddon({
  name: 'phone-alerts',
  version: '1.0.0',
  minAppVersion: '0.11.0',
  icon: '📲',
  description: 'Push a phone notification when a session waits for input, finishes, or fails, through ntfy.sh (free, no account) or your own Telegram bot. Pick which events alert and mute while you are at the desk.',
  author: 'yaam',
  hosts: ['ntfy.sh', 'api.telegram.org'],
  secrets: [
    { name: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token from @BotFather (only for Telegram)' },
    { name: 'NTFY_TOKEN', label: 'ntfy access token (only for reserved/protected topics)' },
  ],
  permissions: ['storage', 'http', 'secrets', 'ui'],
  view: 'index.html',
  tools: [
    { name: 'send_test', description: 'Send a test alert with the saved settings.', handler: 'src/tools/send_test.ts' },
  ],
  hooks: {
    onNeedsInput: 'src/hooks/onNeedsInput.ts',
    onSessionExit: 'src/hooks/onSessionExit.ts',
  },
  contributes: {
    commands: [
      { id: 'test', title: 'Phone alerts: send a test', run: 'send_test' },
      { id: 'settings', title: 'Phone alerts: settings', open: 'popup' },
    ],
  },
})
