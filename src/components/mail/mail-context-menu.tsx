import { IconArchive, IconMail, IconStar, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

type MailContextMenuProps = {
  x: number
  y: number
  labels: {
    markUnread: string
    star: string
    archive: string
    delete: string
  }
  onClose: () => void
}

export function MailContextMenu({ x, y, labels, onClose }: MailContextMenuProps) {
  return (
    <div className="mail-context-menu" role="menu" style={{ left: x, top: y }} onClick={onClose}>
      <Button className="context-menu-item" variant="ghost" disabled role="menuitem"><IconMail aria-hidden="true" size={16} stroke={1.8} />{labels.markUnread}</Button>
      <Button className="context-menu-item" variant="ghost" disabled role="menuitem"><IconStar aria-hidden="true" size={16} stroke={1.8} />{labels.star}</Button>
      <div className="context-menu-divider" />
      <Button className="context-menu-item" variant="ghost" disabled role="menuitem"><IconArchive aria-hidden="true" size={16} stroke={1.8} />{labels.archive}</Button>
      <Button className="context-menu-item danger" variant="danger" disabled role="menuitem"><IconTrash aria-hidden="true" size={16} stroke={1.8} />{labels.delete}</Button>
    </div>
  )
}
