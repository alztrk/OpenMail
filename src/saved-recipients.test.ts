import { afterEach, describe, expect, it } from 'vitest'
import { loadSavedRecipients } from './lib/saved-recipients'

describe('loadSavedRecipients', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('filters malformed local records before they reach recipient suggestions', () => {
    localStorage.setItem('openmail.saved-recipients', JSON.stringify([
      { id: 'valid', email: 'valid@example.com', name: 'Valid', updatedAt: '2026-09-15T08:00:00.000Z' },
      { id: 'bad-email', email: 'not-an-email', name: 'Bad email', updatedAt: '2026-09-15T08:01:00.000Z' },
      { id: 'bad-date', email: 'date@example.com', name: 'Bad date', updatedAt: 'not-a-date' },
      { id: '', email: 'empty-id@example.com', name: 'Empty id', updatedAt: '2026-09-15T08:02:00.000Z' },
    ]))

    expect(loadSavedRecipients()).toEqual([
      { id: 'valid', email: 'valid@example.com', name: 'Valid', updatedAt: '2026-09-15T08:00:00.000Z' },
    ])
  })
})
