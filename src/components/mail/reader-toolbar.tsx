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
}

export function ReaderToolbar({ labels, onBack }: ReaderToolbarProps) {
  return (
    <div className="reader-toolbar">
      <Button className="reader-back" variant="ghost" size="icon" aria-label={labels.backToMailList} onClick={onBack}><IconArrowLeft aria-hidden="true" size={17} stroke={1.8} /></Button>
      <Button className="reader-tool" variant="ghost" disabled><IconArchive className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.archive}</Button>
      <Button className="reader-tool danger" variant="danger" disabled><IconTrash className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.delete}</Button>
      <Button className="reader-tool" variant="ghost" disabled><IconMail className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.markUnread}</Button>
      <span className="reader-toolbar-spacer" />
      <Button className="reader-tool" variant="ghost" disabled><IconMessageReply className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} />{labels.reply}</Button>
      <Button className="reader-tool icon-only" variant="ghost" size="icon" aria-label={labels.moreActions} disabled><IconDots className="reader-tool-icon" aria-hidden="true" size={16} stroke={1.8} /></Button>
    </div>
  )
}
