import { IconMail } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { IconUserPlus } from '@tabler/icons-react'

type EmptyStateProps = {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}

export function EmptyState({ title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="reader-empty">
      <div className="reader-empty-content">
        <div className="reader-empty-mark" aria-hidden="true"><IconMail size={22} stroke={1.8} /></div>
        <h2>{title}</h2>
        <p>{description}</p>
        {actionLabel && onAction ? <Button className="empty-state-action" type="button" onClick={onAction}><IconUserPlus aria-hidden="true" size={15} stroke={1.8} />{actionLabel}</Button> : null}
      </div>
    </div>
  )
}
