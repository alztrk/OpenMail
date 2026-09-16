import { describe, expect, it } from 'vitest'
import { formatFileSize } from './formatters'

describe('formatFileSize', () => {
  it('uses the active locale decimal separator', () => {
    expect(formatFileSize(1.5 * 1024 * 1024, 'en')).toBe('1.5 MB')
    expect(formatFileSize(1.5 * 1024 * 1024, 'de')).toBe('1,5 MB')
  })
})
