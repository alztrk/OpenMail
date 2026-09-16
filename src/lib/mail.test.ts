import { describe, expect, it } from 'vitest'

import { compareMessageTimes, getMessageIdentity } from './mail'

describe('getMessageIdentity', () => {
  it('keeps equal provider IDs separate across accounts', () => {
    const gmailMessage = { id: 'same-provider-id', account_id: 'gmail:first@example.com' }
    const outlookMessage = { id: 'same-provider-id', account_id: 'outlook:second@example.com' }

    expect(getMessageIdentity(gmailMessage)).not.toBe(getMessageIdentity(outlookMessage))
  })

  it('uses the active account for messages loaded from a single-account cache', () => {
    expect(getMessageIdentity({ id: 'cached-message' }, 'gmail:first@example.com'))
      .toBe('gmail:first@example.com:cached-message')
  })

  it('sorts numeric provider timestamps together with ISO timestamps', () => {
    const newer = String(Date.parse('2026-09-08T12:00:00Z'))
    const older = '2026-09-07T12:00:00Z'

    expect(compareMessageTimes(newer, older)).toBeLessThan(0)
    expect(compareMessageTimes(older, newer)).toBeGreaterThan(0)
  })
})
