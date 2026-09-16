import { IconArchive, IconArrowLeft, IconMail, IconMessageReply, IconTrash } from '@tabler/icons-react'
import type { Ref } from 'react'
import { Button } from '@/components/ui/button'

type ReaderToolbarProps = {
  labels: {
    toolbarLabel: string
    archive: string
    delete: string
    markUnread: string
    reply: string
    backToMailList: string
  }
  onBack: () => void
  onArchive: () => void
  onDelete: () => void
  onMarkUnread: () => void
  onReply: () => void
  backButtonRef?: Ref<HTMLButtonElement>
  disabled?: boolean
  disabledActions?: {
    archive?: boolean
    delete?: boolean
    markUnread?: boolean
    reply?: boolean
  }
}

export function ReaderToolbar({ labels, onBack, onArchive, onDelete, onMarkUnread, onReply, backButtonRef, disabled = false, disabledActions = {} }: ReaderToolbarProps) {
  return (
    <nav className="reader-toolbar" aria-label={labels.toolbarLabel}>
      <Button ref={backButtonRef} className="reader-back" variant="ghost" size="icon" aria-label={labels.backToMailList} title={labels.backToMailList} disabled={disabled} onClick={onBack}><IconArrowLeft aria-hidden="true" size={17} stroke={1.8} /></Button>
      <Button className="reader-tool" variant="ghost" aria-label={labels.archive} title={labels.archive} disabled={disabled || disabledActions.archive} onClick={onArchive}><IconArchive className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} /><span className="reader-tool-label">{labels.archive}</span></Button>
      <Button className="reader-tool danger" variant="ghost" aria-label={labels.delete} title={labels.delete} disabled={disabled || disabledActions.delete} onClick={onDelete}><IconTrash className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} /><span className="reader-tool-label">{labels.delete}</span></Button>
      <Button className="reader-tool mark-unread-tool" variant="ghost" aria-label={labels.markUnread} title={labels.markUnread} disabled={disabled || disabledActions.markUnread} onClick={onMarkUnread}><IconMail className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} /><span className="reader-tool-label">{labels.markUnread}</span></Button>
      <span className="reader-toolbar-spacer" />
      <Button className="reader-tool" variant="ghost" aria-label={labels.reply} title={labels.reply} disabled={disabled || disabledActions.reply} onClick={onReply}><IconMessageReply className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} /><span className="reader-tool-label">{labels.reply}</span></Button>
    </nav>
  )
}
