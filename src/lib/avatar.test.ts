import { describe, expect, it } from 'vitest'

import { getSenderAvatarInitials, getSenderAvatarTone, getSenderAvatarUrl } from './avatar'

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

  it('derives a favicon URL when cached messages do not have one yet', () => {
    expect(getSenderAvatarUrl('sender@OpenAI.com')).toBe('https://www.google.com/s2/favicons?domain=openai.com&sz=64')
  })

  it('rejects malformed sender domains before building a favicon URL', () => {
    expect(getSenderAvatarUrl('sender')).toBeNull()
    expect(getSenderAvatarUrl('sender@example.com/path')).toBeNull()
    expect(getSenderAvatarUrl('sender@-example.com')).toBeNull()
  })
})
