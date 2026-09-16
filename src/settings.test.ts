import { afterEach, describe, expect, it } from 'vitest'
import { loadSettings } from './settings'

describe('loadSettings', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('normalizes invalid stored values before they reach the UI', () => {
    localStorage.setItem('openmail.settings', JSON.stringify({
      fontScale: 2,
      quietHoursStart: '99:99',
      quietHoursEnd: '7:00',
    }))

    const settings = loadSettings()

    expect(settings.fontScale).toBe(1.2)
    expect(settings.quietHoursStart).toBe('22:00')
    expect(settings.quietHoursEnd).toBe('07:00')
  })

  it('preserves every supported locale and rejects unknown locale values', () => {
    localStorage.setItem('openmail.settings', JSON.stringify({ language: 'pt-BR' }))
    expect(loadSettings().language).toBe('pt-BR')

    localStorage.setItem('openmail.settings', JSON.stringify({ language: 'xx' }))
    expect(loadSettings().language).toBe('en')
  })
})
