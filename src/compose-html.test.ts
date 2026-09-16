import { describe, expect, it } from 'vitest'

import { sanitizeComposeHtml } from './lib/compose-html'

describe('sanitizeComposeHtml', () => {
  it('removes executable markup while preserving rich text', () => {
    const sanitized = sanitizeComposeHtml('<p><strong>Hello</strong></p><script>alert(1)</script><img src="x" onerror="alert(1)">')

    expect(sanitized).toContain('<strong>Hello</strong>')
    expect(sanitized).not.toContain('<script')
    expect(sanitized).not.toContain('onerror')
  })
})
