import { afterEach, describe, expect, it } from 'vitest'

import { aggregateNotificationTargets, consumeNotificationDestination, getNotificationLines, getPollingDelayMs, isQuietHours, registerNotificationDestination, shouldSendDesktopNotification } from './notifications'
import { defaultSettings } from '../settings'

afterEach(() => {
  localStorage.clear()
})

describe('notification scheduling', () => {
  it('suppresses desktop notifications while the visible window is focused', () => {
    expect(shouldSendDesktopNotification(true, true)).toBe(false)
    expect(shouldSendDesktopNotification(true, false)).toBe(true)
    expect(shouldSendDesktopNotification(false, true)).toBe(true)
  })

  it('handles quiet hours that cross midnight', () => {
    const settings = { ...defaultSettings, quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' }
    expect(isQuietHours(settings, new Date('2026-09-15T23:30:00'))).toBe(true)
    expect(isQuietHours(settings, new Date('2026-09-15T06:30:00'))).toBe(true)
    expect(isQuietHours(settings, new Date('2026-09-15T12:00:00'))).toBe(false)
  })

  it('backs off polling after repeated failures', () => {
    expect(getPollingDelayMs(true, 0)).toBe(30_000)
    expect(getPollingDelayMs(false, 0)).toBe(30_000)
    expect(getPollingDelayMs(true, 2)).toBe(120_000)
    expect(getPollingDelayMs(false, 10)).toBe(480_000)
  })

  it('keeps the quiet-hours start inclusive and end exclusive', () => {
    const settings = { ...defaultSettings, quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '23:00' }
    expect(isQuietHours(settings, new Date('2026-09-15T22:00:00'))).toBe(true)
    expect(isQuietHours(settings, new Date('2026-09-15T22:59:00'))).toBe(true)
    expect(isQuietHours(settings, new Date('2026-09-15T23:00:00'))).toBe(false)
  })

  it('does not suppress notifications when quiet hours are disabled', () => {
    const settings = { ...defaultSettings, quietHoursEnabled: false, quietHoursStart: '00:00', quietHoursEnd: '23:59' }
    expect(isQuietHours(settings, new Date('2026-09-15T12:00:00'))).toBe(false)
  })
})

describe('notification batches', () => {
  it('deduplicates messages and preserves account grouping', () => {
    const batch = aggregateNotificationTargets([
      {
        accountId: 'account-a',
        newMessageCount: 2,
        messages: [
          { id: 'message-1', thread_id: 'thread-1', sender: 'Design Review', subject: 'Spacing notes' },
          { id: 'message-2', thread_id: null, sender: 'Product Updates', subject: 'This week' },
        ],
      },
      {
        accountId: 'account-b',
        newMessageCount: 1,
        messages: [{ id: 'message-1', thread_id: 'thread-1', sender: 'Other account', subject: 'Different message' }],
      },
    ])

    expect(batch.count).toBe(3)
    expect(batch.accountIds).toEqual(['account-a', 'account-b'])
    expect(batch.messages).toHaveLength(3)
    expect(getNotificationLines(batch)).toEqual([
      'Design Review: Spacing notes',
      'Product Updates: This week',
      'Other account: Different message',
    ])
  })

  it('limits notification text to five messages and handles missing text', () => {
    const batch = aggregateNotificationTargets([
      {
        accountId: 'account-a',
        newMessageCount: 6,
        messages: Array.from({ length: 6 }, (_, index) => ({
          id: `message-${index}`,
          thread_id: null,
          sender: index === 0 ? '  ' : `Sender ${index}`,
          subject: index === 1 ? '  ' : `Subject ${index}`,
        })),
      },
    ])

    expect(getNotificationLines(batch)).toEqual([
      'OpenMail: Subject 0',
      'Sender 1',
      'Sender 2: Subject 2',
      'Sender 3: Subject 3',
      'Sender 4: Subject 4',
    ])
  })
})

describe('notification destinations', () => {
  it('keeps click destinations out of the OS payload while allowing them to be consumed once', () => {
    const key = registerNotificationDestination({ accountId: 'gmail:account@example.com', messageId: 'message-1', threadId: 'thread-1' })
    expect(key).toBeTypeOf('string')
    if (!key) return
    expect(consumeNotificationDestination(key)).toEqual({ accountId: 'gmail:account@example.com', messageId: 'message-1', threadId: 'thread-1' })
    expect(consumeNotificationDestination(key)).toBeNull()
  })

  it('ignores malformed stored destinations', () => {
    localStorage.setItem('openmail.notification-destinations', '{"broken":{"accountId":true}}')
    expect(consumeNotificationDestination('broken')).toBeNull()
  })

  it('keeps only the most recent fifty destinations', () => {
    const keys = Array.from({ length: 51 }, (_, index) => {
      const key = registerNotificationDestination({
        accountId: `account-${index}`,
        messageId: `message-${index}`,
        threadId: null,
      })
      expect(key).toBeTypeOf('string')
      return key
    })

    const oldestKey = keys[0]
    const newestKey = keys[50]
    if (!oldestKey || !newestKey) return
    expect(consumeNotificationDestination(oldestKey)).toBeNull()
    expect(consumeNotificationDestination(newestKey)).toEqual({
      accountId: 'account-50',
      messageId: 'message-50',
      threadId: null,
    })
  })
})
