import type { NotificationDestination } from '@/lib/notifications'

export type NotificationHistoryEntry = {
  id: string
  title: string
  body: string
  createdAt: number
  destination: NotificationDestination | null
}

const MAX_NOTIFICATION_HISTORY_ENTRIES = 30

export function appendNotificationHistory(
  entries: NotificationHistoryEntry[],
  entry: NotificationHistoryEntry,
): NotificationHistoryEntry[] {
  return [entry, ...entries.filter((current) => current.id !== entry.id)]
    .slice(0, MAX_NOTIFICATION_HISTORY_ENTRIES)
}

export function clearNotificationHistory(): NotificationHistoryEntry[] {
  return []
}
