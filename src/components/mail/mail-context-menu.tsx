import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconAlertTriangle, IconArchive, IconMail, IconStar, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

type MailContextMenuProps = {
  x: number
  y: number
  menuLabel: string
  labels: {
    markUnread: string
    star: string
    reportSpam: string
    archive: string
    delete: string
  }
  onClose: () => void
  onMarkUnread: () => void
  onStar: () => void
  onSpam: () => void
  onArchive: () => void
  onDelete: () => void
  showSpam: boolean
  returnFocusElement: HTMLButtonElement | null
  disabled?: boolean
  disabledActions?: {
    markUnread?: boolean
    star?: boolean
    spam?: boolean
    archive?: boolean
    delete?: boolean
  }
}

export function MailContextMenu({ x, y, menuLabel, labels, onClose, onMarkUnread, onStar, onSpam, onArchive, onDelete, showSpam, returnFocusElement, disabled = false, disabledActions = {} }: MailContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  const closeMenu = useCallback(() => {
    if (returnFocusElement?.isConnected) returnFocusElement.focus()
    onClose()
  }, [onClose, returnFocusElement])

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const updatePosition = () => {
      const edgePadding = 8
      setPosition({
        left: Math.max(edgePadding, Math.min(x, window.innerWidth - menu.offsetWidth - edgePadding)),
        top: Math.max(edgePadding, Math.min(y, window.innerHeight - menu.offsetHeight - edgePadding)),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [x, y])

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      const menuItems = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      const activeIndex = menuItems.findIndex((item) => item === document.activeElement)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        if (menuItems.length === 0) return
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? menuItems.length - 1
            : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length
        menuItems[nextIndex].focus()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeMenu])

  return (
    <div ref={menuRef} className="mail-context-menu" role="menu" aria-label={menuLabel} aria-orientation="vertical" style={{ left: position.left, top: position.top }} onClick={closeMenu}>
      <Button className="context-menu-item" variant="ghost" role="menuitem" disabled={disabled || disabledActions.markUnread} onClick={onMarkUnread}><IconMail aria-hidden="true" size={16} stroke={1.8} />{labels.markUnread}</Button>
      <Button className="context-menu-item" variant="ghost" role="menuitem" disabled={disabled || disabledActions.star} onClick={onStar}><IconStar aria-hidden="true" size={16} stroke={1.8} />{labels.star}</Button>
      {showSpam ? <Button className="context-menu-item" variant="ghost" role="menuitem" disabled={disabled || disabledActions.spam} onClick={onSpam}><IconAlertTriangle aria-hidden="true" size={16} stroke={1.8} />{labels.reportSpam}</Button> : null}
      <div className="context-menu-divider" />
      <Button className="context-menu-item" variant="ghost" role="menuitem" disabled={disabled || disabledActions.archive} onClick={onArchive}><IconArchive aria-hidden="true" size={16} stroke={1.8} />{labels.archive}</Button>
      <Button className="context-menu-item danger" variant="ghost" role="menuitem" disabled={disabled || disabledActions.delete} onClick={onDelete}><IconTrash aria-hidden="true" size={16} stroke={1.8} />{labels.delete}</Button>
    </div>
  )
}
