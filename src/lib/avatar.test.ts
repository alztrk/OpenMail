import { describe, expect, it } from 'vitest'

import { getSenderAvatarInitials, getSenderAvatarTone } from './avatar'

describe('sender avatars', () => {
  it('creates readable initials from sender names', () => {
    expect(getSenderAvatarInitials('Google Developers')).toBe('GD')
    expect(getSenderAvatarInitials('ChatGPT')).toBe('CH')
    expect(getSenderAvatarInitials('')).toBe('?')
  })

  it('keeps avatar tone stable for the same sender address', () => {
    expect(getSenderAvatarTone('Unknown sender', 'sender@example.com')).toBe(getSenderAvatarTone('Different label', 'sender@example.com'))
    expect(getSenderAvatarTone('Unknown sender', 'sender@example.com')).toBeGreaterThanOrEqual(0)
    expect(getSenderAvatarTone('Unknown sender', 'sender@example.com')).toBeLessThan(4)
  })
})
