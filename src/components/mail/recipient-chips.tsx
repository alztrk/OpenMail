import { IconX } from '@tabler/icons-react'
import { useRef } from 'react'
import { cn, isValidEmailAddress } from '@/lib/utils'
import { Input } from '@/components/ui/input'

type RecipientChipsProps = {
  id: string
  value: string
  placeholder: string
  removeLabel: string
  invalid: boolean
  onChange: (value: string) => void
}

function splitCommittedRecipients(value: string): { committed: string[]; draft: string; hasDelimiter: boolean } {
  const parts = value.split(/[;,]/)
  const hasDelimiter = parts.length > 1
  const draft = hasDelimiter ? parts.at(-1)?.trim() ?? '' : value.trim()
  const committed = hasDelimiter ? parts.slice(0, -1).map((part) => part.trim()).filter(Boolean) : []
  return { committed, draft, hasDelimiter }
}

export function RecipientChips({ id, value, placeholder, removeLabel, invalid, onChange }: RecipientChipsProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { committed, draft, hasDelimiter } = splitCommittedRecipients(value)

  const commitDraft = () => {
    const address = draft.trim()
    if (!address) return
    const nextValue = [...committed, address].join(', ')
    onChange(`${nextValue}, `)
    inputRef.current?.focus()
  }

  const removeRecipient = (index: number) => {
    const remaining = committed.filter((_, recipientIndex) => recipientIndex !== index)
    const nextValue = [...remaining, draft].filter(Boolean).join(', ')
    onChange(hasDelimiter && !draft ? `${nextValue}${nextValue ? ', ' : ''}` : nextValue)
    inputRef.current?.focus()
  }

  return (
    <div className={cn('recipient-chips', invalid && 'has-error')} onClick={() => inputRef.current?.focus()}>
      {committed.map((address, index) => (
        <span className={cn('recipient-chip', !isValidEmailAddress(address) && 'invalid')} key={`${address}-${index}`}>
          <span>{address}</span>
          <button type="button" aria-label={`${removeLabel}: ${address}`} onClick={(event) => { event.stopPropagation(); removeRecipient(index) }}><IconX aria-hidden="true" size={13} stroke={2} /></button>
        </span>
      ))}
      <Input ref={inputRef} id={id} className="recipient-chip-input" type="text" inputMode="email" value={draft} onChange={(event) => onChange(hasDelimiter ? `${committed.join(', ')}, ${event.target.value}` : event.target.value)} onKeyDown={(event) => {
        if (event.key === ',' || event.key === ';') {
          event.preventDefault()
          commitDraft()
        } else if ((event.key === 'Enter' || event.key === 'Tab') && draft.trim()) {
          event.preventDefault()
          commitDraft()
        } else if (event.key === 'Backspace' && !draft && committed.length > 0) {
          removeRecipient(committed.length - 1)
        }
      }} placeholder={committed.length === 0 ? placeholder : undefined} aria-invalid={invalid} />
    </div>
  )
}
