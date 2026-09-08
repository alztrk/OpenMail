import { IconArchive, IconArrowLeft, IconDots, IconMail, IconMessageReply, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

type ReaderToolbarProps = {
  labels: {
    archive: string
    delete: string
    markUnread: string
    reply: string
    moreActions: string
    backToMailList: string
  }
  onBack: () => void
  onArchive: () => void
  onDelete: () => void
  onMarkUnread: () => void
  onReply: () => void
  disabled?: boolean
}

export function ReaderToolbar({ labels, onBack, onArchive, onDelete, onMarkUnread, onReply, disabled = false }: ReaderToolbarProps) {
  return (
    <div className="reader-toolbar">
      <Button className="reader-back" variant="ghost" size="icon" aria-label={labels.backToMailList} disabled={disabled} onClick={onBack}><IconArrowLeft aria-hidden="true" size={17} stroke={1.8} /></Button>
      <Button className="reader-tool" variant="ghost" disabled={disabled} onClick={onArchive}><IconArchive className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.archive}</Button>
      <Button className="reader-tool danger" variant="danger" disabled={disabled} onClick={onDelete}><IconTrash className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.delete}</Button>
      <Button className="reader-tool" variant="ghost" disabled={disabled} onClick={onMarkUnread}><IconMail className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.markUnread}</Button>
      <span className="reader-toolbar-spacer" />
      <Button className="reader-tool" variant="ghost" disabled={disabled} onClick={onReply}><IconMessageReply className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.reply}</Button>
      <Button className="reader-tool icon-only" variant="ghost" size="icon" aria-label={labels.moreActions} disabled><IconDots className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} /></Button>
    </div>
  )
}
