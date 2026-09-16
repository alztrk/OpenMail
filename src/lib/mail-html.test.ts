import { describe, expect, it } from 'vitest'

import { sanitizeMailHtml } from './mail-html'

describe('sanitizeMailHtml', () => {
  it('removes executable content, remote resources, and CSS trackers', () => {
    const sanitized = sanitizeMailHtml(`
      <script>alert('xss')</script>
      <style>body { background-image: url('https://tracker.invalid/pixel') }</style>
      <img src="https://tracker.invalid/open" srcset="https://tracker.invalid/large 2x">
      <div style="color: red; background-image: url('https://tracker.invalid/background')" background="https://tracker.invalid/bg">Message</div>
    `)

    expect(sanitized).not.toContain('<script')
    expect(sanitized).not.toContain('tracker.invalid')
    expect(sanitized).toContain('style="color: red"')
    expect(sanitized).toContain('Message')
  })

  it('preserves embedded image data without allowing remote image requests', () => {
    const sanitized = sanitizeMailHtml('<img src="data:image/png;base64,AAAA" /><img src="data:image/svg+xml,<svg></svg>" /><img src="http://example.com/image.png" />')

    expect(sanitized).toContain('src="data:image/png;base64,AAAA"')
    expect(sanitized).not.toContain('data:image/svg+xml')
    expect(sanitized).not.toContain('http://example.com/image.png')
  })
})
