'use strict'

// Simple in-memory notification store (capped). It is the only manager-shaped
// module kept from the old layer because it is simple and correct.

class NotificationStore {
  constructor({ sendEvent }) {
    this.sendEvent = sendEvent
    this.notifications = [
      {
        id: 'notif-init-1',
        title: 'MeshDesk P2P Engine Active',
        description: 'Bound to Hyperswarm DHT with secure challenge pairing.',
        type: 'info',
        timestamp: new Date().toISOString(),
        read: false
      }
    ]
  }

  getNotifications() {
    return this.notifications
  }

  addNotification(title, description, type = 'info') {
    const item = {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      description,
      type,
      timestamp: new Date().toISOString(),
      read: false
    }
    this.notifications.unshift(item)
    this.notifications = this.notifications.slice(0, 50)
    if (this.sendEvent) this.sendEvent('notification.received', item)
    return item
  }

  markAllRead() {
    this.notifications.forEach((n) => (n.read = true))
    return this.notifications
  }

  clear() {
    this.notifications = []
    return []
  }
}

module.exports = NotificationStore
