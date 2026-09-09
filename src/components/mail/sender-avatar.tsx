type SenderAvatarProps = {
  className: string
  label: string
  imageUrl?: string | null
  loading?: 'eager' | 'lazy'
}

export function SenderAvatar({ className, label, imageUrl, loading = 'eager' }: SenderAvatarProps) {
  return (
    <span className={className} aria-hidden="true">
      {imageUrl ? <img src={imageUrl} alt="" loading={loading} decoding="async" referrerPolicy="no-referrer" onLoad={(event) => { event.currentTarget.hidden = false }} onError={(event) => { event.currentTarget.hidden = true }} /> : null}
      <span>{label.slice(0, 1).toUpperCase()}</span>
    </span>
  )
}
