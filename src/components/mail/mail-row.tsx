import type { KeyboardEvent, MouseEvent } from 'react'

type MailRowMessage = {
  id: string
  sender: string
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
}

export function MailRow({ message, selected, unreadLabel, onSelect, onContextMenu }: MailRowProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(message.id)
    }
  }

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onContextMenu(message.id, event.clientX, event.clientY)
  }

  return (
    <div className={`message-row ${selected ? 'selected' : ''} ${message.unread ? 'unread' : ''}`} data-context-menu="mail" role="button" tabIndex={0} aria-label={`${message.sender}: ${message.subject}`} onClick={() => onSelect(message.id)} onContextMenu={handleContextMenu} onKeyDown={handleKeyDown}>
      <span className="message-row-topline">
        <span className="message-sender-group">
          <span className={`unread-dot ${message.unread ? '' : 'inactive'}`} aria-label={message.unread ? unreadLabel : undefined} />
          <span className="message-sender">{message.sender}</span>
        </span>
        <span className="message-time">{message.time}</span>
      </span>
      <span className="message-subject">{message.subject}</span>
      <span className="message-preview">{message.preview}</span>
    </div>
  )
}
