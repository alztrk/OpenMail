import type { KeyboardEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { getSenderLabel } from '@/lib/mail'
import { SenderAvatar } from '@/components/mail/sender-avatar'

type MailRowMessage = {
  id: string
  sender: string
  address: string
  avatar_url?: string | null
  subject: string
  preview: string
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
  onSelect: (messageId: string) => void
  onToggleSelection: (messageId: string) => void
  onContextMenu: (messageId: string, x: number, y: number, returnFocusElement: HTMLButtonElement) => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, messageId: string) => void
}

export function MailRow({ message, selected, selectionChecked, unreadLabel, onSelect, onToggleSelection, onContextMenu, onKeyDown }: MailRowProps) {
  const { t } = useTranslation()
  const sender = getSenderLabel(message.sender, message.address)
  const subject = message.subject || t('noSubject')
  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const rowBounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX || rowBounds.left + 16
    const y = event.clientY || rowBounds.top + Math.min(rowBounds.height / 2, 24)
    onContextMenu(message.id, x, y, event.currentTarget)
  }

  return (
    <div className={`message-row ${selected ? 'selected' : ''} ${message.unread ? 'unread' : ''}`} data-context-menu="mail" data-mail-id={message.id}>
      <button className="message-row-content" type="button" aria-current={selected ? 'true' : undefined} aria-label={`${message.unread ? `${unreadLabel}, ` : ''}${sender}: ${subject}`} onClick={() => onSelect(message.id)} onContextMenu={handleContextMenu} onKeyDown={(event) => onKeyDown?.(event, message.id)}>
        <span className="message-row-topline">
          <span className="message-sender-group">
            <SenderAvatar className="message-avatar" label={sender} imageUrl={message.avatar_url} loading="lazy" />
            <span className={`unread-dot ${message.unread ? '' : 'inactive'}`} aria-hidden="true" />
            <span className="message-sender" dir="auto">{sender}</span>
          </span>
          <span className="message-time">{message.time}</span>
        </span>
        <span className="message-subject" dir="auto">{subject}</span>
        <span className="message-preview" dir="auto">{message.preview}</span>
      </button>
      <button className={`message-selection-box ${selectionChecked ? 'checked' : ''}`} type="button" aria-pressed={selectionChecked} aria-label={selectionChecked ? t('deselectMessage') : t('selectMessage')} onClick={() => onToggleSelection(message.id)} />
    </div>
  )
}
