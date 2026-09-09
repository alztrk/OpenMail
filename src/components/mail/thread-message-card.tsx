import { useId, useState } from 'react'
import { IconArchive, IconChevronDown, IconCornerUpLeft, IconDownload, IconMail, IconMailOpened, IconPaperclip, IconStar, IconTrash } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { MailHtml } from '@/components/mail/mail-html'
import { getSenderLabel } from '@/lib/mail'
import { SenderAvatar } from '@/components/mail/sender-avatar'
import { Button } from '@/components/ui/button'

type ThreadMessageCardProps = {
  sender: string
  address: string
  avatarUrl?: string | null
  time: string
  body: string
  bodyHtml?: string | null
  fontScale: number
  dateTime: string
  recipient: string
  attachments: Array<{ id: string; filename: string; size: number }>
  downloadingAttachmentId: string | null
  unread: boolean
  starred: boolean
  archiveLabel: string
  onLinkClick: (href: string) => void
  onReply: () => void
  onDownloadAttachment: (attachment: { id: string; filename: string; size: number }) => void
  onToggleRead: () => void
  onToggleStar: () => void
  onArchive: () => void
  onDelete: () => void
  disabledActions?: {
    star?: boolean
    markRead?: boolean
    archive?: boolean
    delete?: boolean
    reply?: boolean
  }
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function ThreadMessageCard({ sender, address, avatarUrl, time, body, bodyHtml, fontScale, dateTime, recipient, attachments, downloadingAttachmentId, unread, starred, archiveLabel, onLinkClick, onReply, onDownloadAttachment, onToggleRead, onToggleStar, onArchive, onDelete, disabledActions = {} }: ThreadMessageCardProps) {
  const { t } = useTranslation()
  const senderLabel = getSenderLabel(sender, address)
  const bodyId = useId()
  const detailsId = useId()
  const [isExpanded, setIsExpanded] = useState(false)
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)

  return (
    <article className="thread-message">
      <button className="thread-message-toggle" type="button" aria-expanded={isExpanded} aria-controls={bodyId} onClick={() => setIsExpanded((current) => !current)}>
        <span className="thread-message-toggle-identity"><SenderAvatar className="thread-message-avatar" label={senderLabel} imageUrl={avatarUrl} loading="lazy" /><span className="thread-message-summary"><strong dir="auto">{senderLabel}</strong><span dir="ltr">{address}</span></span></span>
        <span className="thread-message-meta"><time dateTime={dateTime}>{time}</time><IconChevronDown aria-hidden="true" size={15} stroke={1.8} /></span>
      </button>
      {isExpanded ? <div className="thread-message-body" id={bodyId}>
        <div className="thread-message-actions"><button className="thread-details-toggle" type="button" aria-expanded={isDetailsOpen} aria-controls={detailsId} onClick={() => setIsDetailsOpen((current) => !current)}>{t(isDetailsOpen ? 'hideDetails' : 'showDetails')}<IconChevronDown aria-hidden="true" size={14} stroke={1.8} /></button><div className="thread-message-icon-actions"><Button variant="ghost" size="icon" type="button" aria-label={t('starMail')} title={t('starMail')} aria-pressed={starred} disabled={disabledActions.star} onClick={onToggleStar}><IconStar aria-hidden="true" size={15} stroke={1.8} fill={starred ? 'currentColor' : 'none'} /></Button><Button variant="ghost" size="icon" type="button" aria-label={t(unread ? 'markRead' : 'markUnread')} title={t(unread ? 'markRead' : 'markUnread')} disabled={disabledActions.markRead} onClick={onToggleRead}>{unread ? <IconMailOpened aria-hidden="true" size={15} stroke={1.8} /> : <IconMail aria-hidden="true" size={15} stroke={1.8} />}</Button><Button variant="ghost" size="icon" type="button" aria-label={archiveLabel} title={archiveLabel} disabled={disabledActions.archive} onClick={onArchive}><IconArchive aria-hidden="true" size={15} stroke={1.8} /></Button><Button variant="ghost" size="icon" type="button" aria-label={t('delete')} title={t('delete')} disabled={disabledActions.delete} onClick={onDelete}><IconTrash aria-hidden="true" size={15} stroke={1.8} /></Button></div></div>
        {isDetailsOpen ? <div className="thread-message-details" id={detailsId}><span><small>{t('from')}</small><span dir="ltr">{address}</span></span><span><small>{t('to')}</small><span dir="ltr">{recipient}</span></span></div> : null}
        {bodyHtml ? <MailHtml html={bodyHtml} title={t('mailContent')} fontScale={fontScale} onLinkClick={onLinkClick} /> : body ? <p className="reader-plain-text" dir="auto">{body}</p> : <p className="reader-no-content">{t('messageContentUnavailable')}</p>}
        {attachments.length > 0 ? <section className="thread-message-attachments" aria-label={t('attachments')}><h4><IconPaperclip aria-hidden="true" size={15} stroke={1.8} />{t('attachments')}</h4>{attachments.map((attachment) => <Button className="attachment-button" key={attachment.id} variant="ghost" type="button" disabled={downloadingAttachmentId !== null} onClick={() => onDownloadAttachment(attachment)}><span className="attachment-name"><IconPaperclip aria-hidden="true" size={14} stroke={1.8} /><span>{attachment.filename}</span></span><span className="attachment-size">{formatFileSize(attachment.size)}</span><IconDownload aria-hidden="true" size={15} stroke={1.8} /></Button>)}</section> : null}
        <Button className="thread-message-reply" variant="ghost" type="button" disabled={disabledActions.reply} onClick={onReply}><IconCornerUpLeft aria-hidden="true" size={15} stroke={1.8} />{t('reply')}</Button>
      </div> : null}
    </article>
  )
}
