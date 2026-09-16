import { useEffect, useMemo, useRef } from 'react'

import { sanitizeMailHtml } from '../../lib/mail-html'

type MailHtmlProps = {
  html: string
  title: string
  fontScale: number
  onLinkClick: (href: string) => void
}

export function MailHtml({ html, title, fontScale, onLinkClick }: MailHtmlProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const sanitizedHtml = useMemo(() => sanitizeMailHtml(html), [html])
  const normalizedFontScale = Math.min(1.3, Math.max(0.9, fontScale))

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return undefined
    frame.style.height = ''

    const handleLoad = () => {
      const document = frame.contentDocument
      if (!document) return
      document.documentElement.dir = 'auto'
      cleanupRef.current?.()
      const responsiveStyle = document.createElement('style')
      responsiveStyle.textContent = `
        :root { color-scheme: light; }
        html { zoom: ${normalizedFontScale} !important; background: #ffffff !important; }
        html, body { width: 100%; max-width: 100%; min-height: 100%; margin: 0; overflow-x: hidden; }
        body {
          box-sizing: border-box;
          width: min(100%, 760px) !important;
          margin: 0 auto !important;
          padding: 34px clamp(20px, 5vw, 48px) 56px !important;
          background: #ffffff !important;
          color: #27364a !important;
          font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif !important;
          font-size: 15px !important;
          line-height: 1.65 !important;
        }
        body, body * { box-sizing: border-box; }
        body *:not(img):not(svg) { font-family: inherit !important; }
        body > table,
        body > center,
        body > div,
        body > main,
        body > section { width: 100% !important; max-width: 100% !important; margin-right: auto !important; margin-left: auto !important; }
        table { max-width: 100% !important; }
        td, th { max-width: 100%; line-height: inherit !important; }
        h1, h2, h3, h4, h5, h6 {
          color: #172b42 !important;
          font-weight: 700 !important;
          letter-spacing: -0.02em !important;
          line-height: 1.2 !important;
        }
        h1 { font-size: 30px !important; }
        h2 { font-size: 24px !important; }
        h3 { font-size: 19px !important; }
        h4, h5, h6 { font-size: 16px !important; }
        p, li { line-height: 1.65 !important; }
        a { color: #2e638f !important; }
        hr { border: 0 !important; border-top: 1px solid #dbe5ef !important; }
        img { display: block; max-width: 100% !important; height: auto !important; }
        pre { max-width: 100%; white-space: pre-wrap !important; overflow-wrap: anywhere; }
      `
      document.head.append(responsiveStyle)
      let resizeFrameId: number | null = null
      const resize = () => {
        if (resizeFrameId !== null) return
        resizeFrameId = window.requestAnimationFrame(() => {
          resizeFrameId = null
          const nextHeight = Math.max(120, document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
          const currentHeight = Number.parseFloat(frame.style.height)
          if (Number.isFinite(currentHeight) && Math.abs(currentHeight - nextHeight) < 1) return
          frame.style.height = `${nextHeight}px`
        })
      }
      const resizeObserver = document.body ? new ResizeObserver(resize) : undefined
      resizeObserver?.observe(document.body)
      const mutationObserver = new MutationObserver(resize)
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true })
      const imageCleanups = Array.from(document.images).map((image) => {
        // Email images contribute to the message layout. Lazy loading can leave
        // large parts of a message blank until the user scrolls the iframe.
        image.loading = 'eager'
        image.decoding = 'async'
        image.referrerPolicy = 'no-referrer'
        const handleError = () => { image.hidden = true; resize() }
        image.addEventListener('error', handleError)
        image.addEventListener('load', resize)
        if (image.complete) window.requestAnimationFrame(resize)
        return () => {
          image.removeEventListener('error', handleError)
          image.removeEventListener('load', resize)
        }
      })
      const linkCleanups = Array.from(document.querySelectorAll('a[href]')).map((link) => {
        const handleClick = (event: Event) => {
          event.preventDefault()
          const href = link.getAttribute('href')
          if (href) onLinkClick(href)
        }
        link.addEventListener('click', handleClick)
        return () => link.removeEventListener('click', handleClick)
      })
      resize()
      frame.contentWindow?.addEventListener('resize', resize)
      cleanupRef.current = () => {
        if (resizeFrameId !== null) window.cancelAnimationFrame(resizeFrameId)
        resizeObserver?.disconnect()
        mutationObserver.disconnect()
        responsiveStyle.remove()
        imageCleanups.forEach((cleanup) => cleanup())
        linkCleanups.forEach((cleanup) => cleanup())
        frame.contentWindow?.removeEventListener('resize', resize)
      }
    }

    frame.addEventListener('load', handleLoad)
    if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.body?.childNodes.length) handleLoad()
    return () => {
      frame.removeEventListener('load', handleLoad)
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [html, normalizedFontScale, onLinkClick])

  return <iframe ref={frameRef} className="reader-html-frame" title={title} sandbox="allow-same-origin" srcDoc={sanitizedHtml} dir="auto" />
}
