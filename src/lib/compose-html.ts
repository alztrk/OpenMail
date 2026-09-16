import DOMPurify from 'dompurify'

export function sanitizeComposeHtml(value: string): string {
  return DOMPurify.sanitize(value, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'input', 'object', 'script', 'textarea'],
  })
}
