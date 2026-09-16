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
    expect(getPollingDelayMs(true, 2)).toBe(120_000)
    expect(getPollingDelayMs(false, 10)).toBe(600_000)
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
})

describe('notification destinations', () => {
  it('keeps click destinations out of the OS payload while allowing them to be consumed once', () => {
    const key = registerNotificationDestination({ accountId: 'gmail:account@example.com', messageId: 'message-1', threadId: 'thread-1' })
    expect(key).toBeTypeOf('string')
    if (!key) return
    expect(consumeNotificationDestination(key)).toEqual({ accountId: 'gmail:account@example.com', messageId: 'message-1', threadId: 'thread-1' })
    expect(consumeNotificationDestination(key)).toBeNull()
  })
})
