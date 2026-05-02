import { EventEmitter } from 'events'

export interface CashuNotification {
  kind: string
  payload: Record<string, unknown>
}

class NotificationBus extends EventEmitter {
  publish(kind: string, payload: Record<string, unknown>): void {
    this.emit('notification', { kind, payload } satisfies CashuNotification)
  }
}

export const notificationBus = new NotificationBus()
