import { IconAlertTriangle, IconMail, IconMailPlus, IconRefresh } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

type EmptyStateProps = {
  title: string
  description: string
  icon?: 'mail' | 'account' | 'error'
  actionLabel?: string
  actionHasPopup?: 'dialog'
  actionIcon?: 'state' | 'refresh'
  onAction?: () => void
}

export function EmptyState({ title, description, icon = 'mail', actionLabel, actionHasPopup, actionIcon = 'state', onAction }: EmptyStateProps) {
  const StateIcon = icon === 'account' ? IconMailPlus : icon === 'error' ? IconAlertTriangle : IconMail
  const ActionIcon = actionIcon === 'refresh' ? IconRefresh : StateIcon

  return (
    <div className="reader-empty">
      <div className="reader-empty-content">
        <div className={`reader-empty-mark ${icon === 'error' ? 'error' : ''}`} aria-hidden="true"><StateIcon size={22} stroke={1.8} /></div>
        <h2>{title}</h2>
        <p>{description}</p>
        {actionLabel && onAction ? <Button className="empty-state-action" type="button" aria-haspopup={actionHasPopup} onClick={onAction}><ActionIcon aria-hidden="true" size={15} stroke={1.8} />{actionLabel}</Button> : null}
      </div>
    </div>
  )
}
