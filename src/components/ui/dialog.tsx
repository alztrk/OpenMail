import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { IconX } from '@tabler/icons-react'

type DialogProps = { open: boolean; title: string; closeLabel: string; children: ReactNode; onClose: () => void }

export function Dialog({ open, title, closeLabel, children, onClose }: DialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return undefined
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusableElements = dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    focusableElements?.[0]?.focus()
    return () => previousActiveElement?.focus()
  }, [open])

  if (!open) return null
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusableElements = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusableElements?.length) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  return <div className="ui-dialog-backdrop" role="presentation" onClick={onClose}><section ref={dialogRef} className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}><div className="ui-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label={closeLabel} onClick={onClose}><IconX aria-hidden="true" size={18} stroke={1.8} /></button></div>{children}</section></div>
}
