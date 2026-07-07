// Activity domain AppState slice. Imports only entity types (never core/types).
import type { EventItem, Notification } from '../../core/entities'

/** Activity feed and notifications. */
export interface ActivitySlice {
  events: EventItem[]
  notifications: Notification[]
}

/** Initial activity slice for a fresh app state. */
export function freshActivitySlice(): ActivitySlice {
  return { events: [], notifications: [] }
}
