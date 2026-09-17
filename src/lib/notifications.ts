import type { AppSettings } from '@/settings'

export type NewMailNotification = {
  id: string
  thread_id: string | null
  sender: string
  subject: string
}

export type NotificationTarget = {
  accountId: string
  newMessageCount: number
  messages: NewMailNotification[]
}

export type NotificationBatch = {
  count: number
  accountIds: string[]
  messages: Array<NewMailNotification & { accountId: string }>
}

export type NotificationDestination = {
  accountId: string
  messageId: string
  threadId: string | null
}

export const NOTIFICATION_ACTION_EVENT = 'openmail:notification-action'

export function shouldSendDesktopNotification(isVisible: boolean, isFocused: boolean): boolean {
  return !(isVisible && isFocused)
}

const DESTINATIONS_STORAGE_KEY = 'openmail.notification-destinations'
const MAX_STORED_DESTINATIONS = 50
const MAX_NOTIFICATION_LINES = 5
const FOREGROUND_POLLING_DELAY_MS = 15_000
const BACKGROUND_POLLING_DELAY_MS = 60_000
const MAX_POLLING_BACKOFF_MS = 10 * 60 * 1000

export function isQuietHours(settings: AppSettings, now = new Date()): boolean {
  if (!settings.quietHoursEnabled) return false
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const [startHour, startMinute] = settings.quietHoursStart.split(':').map(Number)
  const [endHour, endMinute] = settings.quietHoursEnd.split(':').map(Number)
  const startMinutes = startHour * 60 + startMinute
  const endMinutes = endHour * 60 + endMinute
  return startMinutes <= endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes
}

export function getPollingDelayMs(isForeground: boolean, consecutiveFailures: number): number {
  const baseDelay = isForeground ? FOREGROUND_POLLING_DELAY_MS : BACKGROUND_POLLING_DELAY_MS
  if (consecutiveFailures <= 0) return baseDelay
  return Math.min(baseDelay * 2 ** Math.min(consecutiveFailures, 4), MAX_POLLING_BACKOFF_MS)
}

export function aggregateNotificationTargets(targets: NotificationTarget[]): NotificationBatch {
  const accountIds: string[] = []
  const accountIdSet = new Set<string>()
  const seenMessages = new Set<string>()
  const messages: Array<NewMailNotification & { accountId: string }> = []
  let count = 0

  for (const target of targets) {
    count += target.newMessageCount
    if (!accountIdSet.has(target.accountId)) {
      accountIdSet.add(target.accountId)
      accountIds.push(target.accountId)
    }
    for (const message of target.messages) {
      const messageKey = `${target.accountId}:${message.id}`
      if (seenMessages.has(messageKey)) continue
      seenMessages.add(messageKey)
      messages.push({ ...message, accountId: target.accountId })
    }
  }

  return { count, accountIds, messages }
}

export function getNotificationLines(batch: NotificationBatch): string[] {
  return batch.messages.slice(0, MAX_NOTIFICATION_LINES).map((message) => {
    const sender = message.sender.trim() || 'OpenMail'
    const subject = message.subject.trim()
    return subject ? `${sender}: ${subject}` : sender
  })
}

function isNotificationDestination(value: unknown): value is NotificationDestination {
  if (typeof value !== 'object' || value === null) return false
  return 'accountId' in value
    && 'messageId' in value
    && 'threadId' in value
    && typeof value.accountId === 'string'
    && value.accountId.length > 0
    && typeof value.messageId === 'string'
    && value.messageId.length > 0
    && (value.threadId === null || typeof value.threadId === 'string')
}

function loadNotificationDestinations(): Record<string, NotificationDestination> {
  const raw = localStorage.getItem(DESTINATIONS_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => isNotificationDestination(value)),
    )
  } catch {
    return {}
  }
}

export function registerNotificationDestination(destination: NotificationDestination): string | null {
  try {
    const key = crypto.randomUUID()
    const destinations = loadNotificationDestinations()
    const entries = Object.entries({ ...destinations, [key]: destination })
      .slice(-MAX_STORED_DESTINATIONS)
    localStorage.setItem(DESTINATIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    return key
  } catch {
    return null
  }
}

export function consumeNotificationDestination(key: string): NotificationDestination | null {
  try {
    const destinations = loadNotificationDestinations()
    const destination = destinations[key]
    if (!destination) return null
    delete destinations[key]
    localStorage.setItem(DESTINATIONS_STORAGE_KEY, JSON.stringify(destinations))
    return destination
  } catch {
    return null
  }
}
