import type { KeyboardEvent, MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

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
  unreadLabel: string
  onSelect: (messageId: string) => void
  onContextMenu: (messageId: string, x: number, y: number) => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, messageId: string) => void
}

export function MailRow({ message, selected, unreadLabel, onSelect, onContextMenu, onKeyDown }: MailRowProps) {
  const { t } = useTranslation()
  const subject = message.subject || t('noSubject')
  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onContextMenu(message.id, event.clientX, event.clientY)
  }

  return (
    <button className={`message-row ${selected ? 'selected' : ''} ${message.unread ? 'unread' : ''}`} data-context-menu="mail" data-mail-id={message.id} type="button" aria-label={`${message.unread ? `${unreadLabel}, ` : ''}${message.sender}: ${subject}`} onClick={() => onSelect(message.id)} onContextMenu={handleContextMenu} onKeyDown={(event) => onKeyDown?.(event, message.id)}>
      <span className="message-row-topline">
        <span className="message-sender-group">
          <span className="message-avatar" aria-hidden="true">
            {message.avatar_url ? <img src={message.avatar_url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true }} /> : null}
            <span>{message.sender.slice(0, 1).toUpperCase()}</span>
          </span>
          <span className={`unread-dot ${message.unread ? '' : 'inactive'}`} aria-hidden="true" />
          <span className="message-sender">{message.sender}</span>
        </span>
        <span className="message-time">{message.time}</span>
      </span>
      <span className="message-subject">{subject}</span>
      <span className="message-preview">{message.preview}</span>
    </button>
  )
}
