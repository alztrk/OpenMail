import DOMPurify from 'dompurify'

const safeImageDataUrl = /^data:image\/(?:avif|bmp|gif|jpe?g|png|webp)(?:;[^,]*)?,/i
const unsafeCssPattern = /(?:url\s*\(|@import|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding\s*:)/i

export function sanitizeMailHtml(value: string): string {
  const sanitized = DOMPurify.sanitize(value, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'height', 'rel', 'style', 'target', 'valign', 'width'],
    FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'input', 'object', 'script', 'textarea'],
  })
  const document = new DOMParser().parseFromString(sanitized, 'text/html')
  document.querySelectorAll('img, source, video, audio').forEach((element) => {
    const source = element.getAttribute('src')
    if (!source || !safeImageDataUrl.test(source)) element.removeAttribute('src')
    element.removeAttribute('srcset')
    element.removeAttribute('poster')
  })
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((element) => element.remove())
  document.querySelectorAll('[style]').forEach((element) => {
    const style = element.getAttribute('style') ?? ''
    const safeDeclarations = style
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.includes(':') && !unsafeCssPattern.test(declaration))
    if (safeDeclarations.length > 0) element.setAttribute('style', safeDeclarations.join('; '))
    else element.removeAttribute('style')
  })
  document.querySelectorAll('[background], [background-image]').forEach((element) => {
    element.removeAttribute('background')
    element.removeAttribute('background-image')
  })
  return document.body.innerHTML
}
