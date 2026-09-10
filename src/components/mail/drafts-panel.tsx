import { IconChevronRight, IconFileText, IconTrash } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

export type DraftListItem = {
  id: string
  subject: string
  recipient: string
  updatedAt: string
}

type DraftsPanelProps = {
  drafts: DraftListItem[]
  currentDraftId: string | null
  canSave: boolean
  isSaving: boolean
  isLoading: boolean
  formatTime: (value: string) => string
  title: string
  savingLabel: string
  loadingLabel: string
  saveLabel: string
  emptyLabel: string
  untitledLabel: string
  noRecipientsLabel: string
  deleteLabel: string
  onSave: () => void
  onSelect: (draft: DraftListItem) => void
  onDelete: (draft: DraftListItem) => void
}

export function DraftsPanel({ drafts, currentDraftId, canSave, isSaving, isLoading, formatTime, title, savingLabel, loadingLabel, saveLabel, emptyLabel, untitledLabel, noRecipientsLabel, deleteLabel, onSave, onSelect, onDelete }: DraftsPanelProps) {
  return (
    <div className="compose-drafts-panel" role="dialog" aria-label={title}>
      <div className="compose-drafts-header"><strong>{title}</strong><Button type="button" size="default" variant="ghost" disabled={!canSave || isSaving || isLoading} onClick={onSave}>{isLoading ? loadingLabel : isSaving ? savingLabel : saveLabel}</Button></div>
      {drafts.length > 0 ? <ul className="compose-drafts-list">
        {drafts.map((draft) => <li className={draft.id === currentDraftId ? 'is-current' : undefined} key={draft.id}>
          <button className="compose-draft-item" type="button" onClick={() => onSelect(draft)}>
            <IconFileText aria-hidden="true" size={15} stroke={1.8} />
            <span><strong>{draft.subject || untitledLabel}</strong><small>{draft.recipient || noRecipientsLabel} · {formatTime(draft.updatedAt)}</small></span>
            <IconChevronRight aria-hidden="true" size={15} stroke={1.8} />
          </button>
          <button className="compose-draft-delete" type="button" aria-label={`${deleteLabel}: ${draft.subject || untitledLabel}`} title={deleteLabel} onClick={() => onDelete(draft)}><IconTrash aria-hidden="true" size={14} stroke={1.8} /></button>
        </li>)}
      </ul> : <p className="compose-drafts-empty">{emptyLabel}</p>}
    </div>
  )
}
