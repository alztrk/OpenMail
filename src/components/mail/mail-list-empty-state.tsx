import { IconAlertTriangle, IconInbox, IconMailCheck, IconPaperclip, IconSend, IconStar, IconTrash } from '@tabler/icons-react'

type MailListEmptyIcon = 'inbox' | 'sent' | 'spam' | 'trash' | 'starred' | 'unread' | 'attachments'

type MailListEmptyStateProps = {
  icon: MailListEmptyIcon
  title: string
  description: string
}

const iconByState = {
  inbox: IconInbox,
  sent: IconSend,
  spam: IconAlertTriangle,
  trash: IconTrash,
  starred: IconStar,
  unread: IconMailCheck,
  attachments: IconPaperclip,
} as const

export function MailListEmptyState({ icon, title, description }: MailListEmptyStateProps) {
  const StateIcon = iconByState[icon]

  return <div className="message-list-empty" role="status">
    <span className="message-list-empty-icon" aria-hidden="true"><StateIcon size={17} stroke={1.8} /></span>
    <strong>{title}</strong>
    <span>{description}</span>
  </div>
}
