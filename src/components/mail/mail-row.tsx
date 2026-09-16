import type { KeyboardEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { IconPaperclip, IconStar } from '@tabler/icons-react'
import { getSenderLabel } from '@/lib/mail'
import { SenderAvatar } from '@/components/mail/sender-avatar'

type MailRowMessage = {
  id: string
  messageKey: string
  sender: string
  address: string
  avatar_url?: string | null
  subject: string
  preview: string
  accountLabel?: string
  time: string
  unread: boolean
  starred: boolean
  hasAttachment: boolean
}

type MailRowProps = {
  message: MailRowMessage
  selected: boolean
  selectionChecked: boolean
  unreadLabel: string
  isStarDisabled: boolean
  onSelect: (messageId: string) => void
  onToggleSelection: (messageId: string) => void
  onToggleStar: (messageId: string) => void
  onContextMenu: (messageId: string, x: number, y: number, returnFocusElement: HTMLButtonElement) => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, messageId: string) => void
}

export function MailRow({ message, selected, selectionChecked, unreadLabel, isStarDisabled, onSelect, onToggleSelection, onToggleStar, onContextMenu, onKeyDown }: MailRowProps) {
  const { t } = useTranslation()
  const sender = getSenderLabel(message.sender, message.address)
  const subject = message.subject || t('noSubject')
  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const rowBounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX || rowBounds.left + 16
    const y = event.clientY || rowBounds.top + Math.min(rowBounds.height / 2, 24)
    onContextMenu(message.messageKey, x, y, event.currentTarget)
  }

  const handleStarClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onToggleStar(message.messageKey)
  }

  const messageStateLabel = [message.starred ? t('unstarMail') : null, message.hasAttachment ? t('attachments') : null].filter(Boolean).join(', ')
  const messageAccessibleLabel = `${message.unread ? `${unreadLabel}, ` : ''}${sender}: ${subject}${messageStateLabel ? `, ${messageStateLabel}` : ''}`

  return (
    <div className={`message-row ${selected ? 'selected' : ''} ${message.unread ? 'unread' : ''}`} data-context-menu="mail">
      <button className="message-row-content" data-mail-id={message.messageKey} type="button" aria-current={selected ? 'true' : undefined} aria-label={messageAccessibleLabel} onClick={() => onSelect(message.messageKey)} onContextMenu={handleContextMenu} onKeyDown={(event) => onKeyDown?.(event, message.messageKey)}>
        <span className="message-row-topline">
          <span className="message-sender-cell">
            <span className="message-sender-group">
              <SenderAvatar className="message-avatar" label={sender} imageUrl={message.avatar_url} loading="lazy" />
              <span className={`unread-dot ${message.unread ? '' : 'inactive'}`} aria-hidden="true" />
              <span className="message-sender" dir="auto">{sender}</span>
            </span>
            {message.accountLabel ? <span className="message-account" dir="ltr">{message.accountLabel}</span> : null}
          </span>
          <span className="message-row-meta">
            {message.hasAttachment ? <IconPaperclip className="message-attachment-indicator" aria-hidden="true" size={13} stroke={1.8} /> : null}
            <span className="message-time">{message.time}</span>
          </span>
        </span>
        <span className="message-summary">
          <span className="message-subject" dir="auto">{subject}</span>
          <span className="message-preview" dir="auto">{message.preview}</span>
        </span>
      </button>
      <button className={`message-star-button ${message.starred ? 'active' : ''}`} type="button" aria-label={message.starred ? t('unstarMail') : t('starMail')} title={message.starred ? t('unstarMail') : t('starMail')} aria-pressed={message.starred} disabled={isStarDisabled} onClick={handleStarClick} onContextMenu={handleContextMenu}>
        <IconStar aria-hidden="true" size={14} stroke={1.8} fill={message.starred ? 'currentColor' : 'none'} />
      </button>
      <button className={`message-selection-box ${selectionChecked ? 'checked' : ''}`} type="button" aria-pressed={selectionChecked} aria-label={selectionChecked ? t('deselectMessage') : t('selectMessage')} onClick={() => onToggleSelection(message.messageKey)} />
    </div>
  )
}
