import { useState } from 'react'
import { getSenderAvatarInitials, getSenderAvatarTone, getSenderAvatarUrl } from '@/lib/avatar'

type SenderAvatarProps = {
  className: string
  label: string
  address?: string | null
  imageUrl?: string | null
  loading?: 'eager' | 'lazy'
}

export function SenderAvatar({ className, label, address, imageUrl, loading = 'eager' }: SenderAvatarProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const resolvedImageUrl = imageUrl ?? getSenderAvatarUrl(address)
  const initials = getSenderAvatarInitials(label)
  const tone = getSenderAvatarTone(label, address)
  return (
    <span className={`${className} sender-avatar sender-avatar-tone-${tone}`} aria-hidden="true">
      {resolvedImageUrl && failedImageUrl !== resolvedImageUrl ? <img src={resolvedImageUrl} alt="" loading={loading} decoding="async" referrerPolicy="no-referrer" onError={() => setFailedImageUrl(resolvedImageUrl)} /> : <span className="sender-avatar-fallback">{initials}</span>}
    </span>
  )
}
