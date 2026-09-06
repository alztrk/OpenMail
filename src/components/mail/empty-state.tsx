import { IconMail } from '@tabler/icons-react'

type EmptyStateProps = {
  title: string
  description: string
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="reader-empty">
      <div className="reader-empty-content">
        <div className="reader-empty-mark" aria-hidden="true"><IconMail size={22} stroke={1.8} /></div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  )
}
