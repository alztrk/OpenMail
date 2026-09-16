import { describe, expect, it } from 'vitest'

import { sanitizeMailHtml } from './mail-html'

describe('sanitizeMailHtml', () => {
  it('removes executable content and CSS trackers while preserving HTTPS images', () => {
    const sanitized = sanitizeMailHtml(`
      <script>alert('xss')</script>
      <style>body { background-image: url('https://tracker.invalid/pixel') }</style>
      <img src="https://tracker.invalid/open" srcset="https://tracker.invalid/large 2x">
      <img src="http://tracker.invalid/insecure.png">
      <div style="color: red; background-image: url('https://tracker.invalid/background')" background="https://tracker.invalid/bg">Message</div>
    `)

    expect(sanitized).not.toContain('<script')
    expect(sanitized).toContain('src="https://tracker.invalid/open"')
    expect(sanitized).toContain('referrerpolicy="no-referrer"')
    expect(sanitized).not.toContain('http://tracker.invalid/insecure.png')
    expect(sanitized).not.toContain('srcset=')
    expect(sanitized).not.toContain('background-image')
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
