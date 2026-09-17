import { describe, expect, it } from 'vitest'
import { appendNotificationHistory, clearNotificationHistory, type NotificationHistoryEntry } from './lib/notification-history'

function entry(id: string): NotificationHistoryEntry {
  return { id, title: `Sender ${id}`, body: `Subject ${id}`, createdAt: 1, destination: null }
}

describe('notification history', () => {
  it('puts the newest entry first and removes duplicate ids', () => {
    const current = [entry('old'), entry('same')]
    const next = appendNotificationHistory(current, entry('same'))

    expect(next.map((item) => item.id)).toEqual(['same', 'old'])
  })

  it('keeps history bounded to thirty entries', () => {
    const current = Array.from({ length: 30 }, (_, index) => entry(`entry-${index}`))
    const next = appendNotificationHistory(current, entry('new'))

    expect(next).toHaveLength(30)
    expect(next[0]?.id).toBe('new')
    expect(next.at(-1)?.id).toBe('entry-28')
  })

  it('clears all entries', () => {
    expect(clearNotificationHistory()).toEqual([])
  })
})
