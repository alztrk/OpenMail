import { IconBell, IconChevronRight, IconTrash, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import type { NotificationHistoryEntry } from '@/lib/notification-history'

type NotificationCenterProps = {
  entries: NotificationHistoryEntry[]
  title: string
  emptyLabel: string
  clearLabel: string
  closeLabel: string
  openLabel: string
  formatTime: (value: number) => string
  onClear: () => void
  onClose: () => void
  onOpen: (entry: NotificationHistoryEntry) => void
}

export function NotificationCenter({ entries, title, emptyLabel, clearLabel, closeLabel, openLabel, formatTime, onClear, onClose, onOpen }: NotificationCenterProps) {
  return <section className="notification-center" aria-labelledby="notification-center-title">
    <header className="notification-center-header">
      <div className="notification-center-title"><IconBell aria-hidden="true" size={17} stroke={1.8} /><h2 id="notification-center-title">{title}</h2></div>
      <div className="notification-center-actions">
        {entries.length > 0 ? <Button variant="ghost" size="icon" type="button" aria-label={clearLabel} title={clearLabel} onClick={onClear}><IconTrash aria-hidden="true" size={16} stroke={1.8} /></Button> : null}
        <Button variant="ghost" size="icon" type="button" aria-label={closeLabel} title={closeLabel} onClick={onClose}><IconX aria-hidden="true" size={17} stroke={1.8} /></Button>
      </div>
    </header>
    {entries.length === 0 ? <div className="notification-center-empty"><IconBell aria-hidden="true" size={19} stroke={1.8} /><span>{emptyLabel}</span></div> : <div className="notification-center-list" role="list">
      {entries.map((entry) => <button className="notification-center-entry" key={entry.id} type="button" role="listitem" onClick={() => onOpen(entry)} disabled={!entry.destination}>
        <span className="notification-center-entry-copy"><strong dir="auto">{entry.title}</strong><span dir="auto">{entry.body}</span><time dateTime={new Date(entry.createdAt).toISOString()}>{formatTime(entry.createdAt)}</time></span>
        {entry.destination ? <span className="notification-center-entry-action"><span className="visually-hidden">{openLabel}</span><IconChevronRight aria-hidden="true" size={16} stroke={1.8} /></span> : null}
      </button>)}
    </div>}
  </section>
}
