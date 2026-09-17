import { IconClock, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

export type ScheduledMessageSummary = {
  id: string
  account_id: string
  recipient: string
  subject: string
  scheduled_at: number
  last_error: string | null
}

type ScheduledMessagesPanelProps = {
  messages: ScheduledMessageSummary[]
  title: string
  emptyLabel: string
  cancelLabel: string
  formatTime: (value: number) => string
  onCancel: (message: ScheduledMessageSummary) => void
}

export function ScheduledMessagesPanel({ messages, title, emptyLabel, cancelLabel, formatTime, onCancel }: ScheduledMessagesPanelProps) {
  return <div className="scheduled-messages-panel" role="dialog" aria-label={title}>
    <div className="scheduled-messages-heading"><strong>{title}</strong><IconClock aria-hidden="true" size={16} stroke={1.8} /></div>
    {messages.length === 0 ? <p className="scheduled-messages-empty">{emptyLabel}</p> : <div className="scheduled-messages-list">
      {messages.map((message) => <article className="scheduled-message-item" key={message.id}>
        <div><strong>{message.subject}</strong><span dir="ltr">{message.recipient}</span><time dateTime={new Date(message.scheduled_at).toISOString()}>{formatTime(message.scheduled_at)}</time>{message.last_error ? <small role="status">{message.last_error}</small> : null}</div>
        <Button variant="ghost" size="icon" type="button" aria-label={cancelLabel} title={cancelLabel} onClick={() => onCancel(message)}><IconX aria-hidden="true" size={15} stroke={1.8} /></Button>
      </article>)}
    </div>}
  </div>
}
