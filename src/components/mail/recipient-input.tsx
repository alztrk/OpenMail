import { IconBookmark, IconBookmarkPlus, IconX } from '@tabler/icons-react'
import { useId, useMemo, useRef, useState } from 'react'
import { cn, isValidEmailAddress } from '@/lib/utils'
import { Input } from '@/components/ui/input'

export type SavedRecipient = {
  id: string
  email: string
  name: string
  updatedAt: string
}

type RecipientInputProps = {
  id: string
  value: string
  placeholder: string
  removeLabel: string
  saveLabel: string
  savedLabel: string
  suggestionsLabel: string
  invalid: boolean
  savedRecipients: SavedRecipient[]
  onChange: (value: string) => void
  onSaveRecipient: (email: string) => void
}

function splitValue(value: string): { committed: string[]; draft: string } {
  const parts = value.split(/[;,]/)
  const hasDelimiter = parts.length > 1
  return {
    committed: hasDelimiter ? parts.slice(0, -1).map((part) => part.trim()).filter(Boolean) : [],
    draft: hasDelimiter ? parts.at(-1)?.trim() ?? '' : value.trim(),
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function RecipientInput({ id, value, placeholder, removeLabel, saveLabel, savedLabel, suggestionsLabel, invalid, savedRecipients, onChange, onSaveRecipient }: RecipientInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const { committed, draft } = splitValue(value)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [isInputFocused, setIsInputFocused] = useState(false)
  const usedEmails = useMemo(() => new Set(committed.map(normalizeEmail)), [committed])
  const matchingSuggestions = useMemo(() => {
    const query = draft.toLowerCase()
    if (!query) return []
    return savedRecipients
      .filter((recipient) => !usedEmails.has(normalizeEmail(recipient.email)))
      .filter((recipient) => recipient.email.toLowerCase().includes(query) || recipient.name.toLowerCase().includes(query))
      .slice(0, 6)
  }, [draft, savedRecipients, usedEmails])
  const suggestions = isInputFocused ? matchingSuggestions : []

  const updateDraft = (nextDraft: string) => {
    setActiveSuggestion(0)
    const nextValue = committed.length > 0 ? `${committed.join(', ')}, ${nextDraft}` : nextDraft
    onChange(nextValue)
  }

  const commitAddress = (address = draft) => {
    const normalized = address.trim()
    if (!normalized || !isValidEmailAddress(normalized) || usedEmails.has(normalizeEmail(normalized))) return false
    onChange(`${[...committed, normalized].join(', ')}, `)
    inputRef.current?.focus()
    return true
  }

  const removeRecipient = (index: number) => {
    const remaining = committed.filter((_, recipientIndex) => recipientIndex !== index)
    onChange(`${remaining.join(', ')}${draft ? `${remaining.length > 0 ? ', ' : ''}${draft}` : remaining.length > 0 ? ', ' : ''}`)
    inputRef.current?.focus()
  }

  const selectSuggestion = (suggestion: SavedRecipient) => {
    commitAddress(suggestion.email)
  }

  return (
    <div className={cn('recipient-input', invalid && 'has-error')} onClick={() => inputRef.current?.focus()}>
      {committed.map((address, index) => {
        const savedRecipient = savedRecipients.find((recipient) => normalizeEmail(recipient.email) === normalizeEmail(address))
        return (
          <span className="recipient-chip" key={normalizeEmail(address)}>
            <span className="recipient-chip-label" title={address}>{savedRecipient?.name ? `${savedRecipient.name} <${address}>` : address}</span>
            {isValidEmailAddress(address) && !savedRecipient ? <button type="button" className="recipient-chip-action recipient-chip-save" aria-label={`${saveLabel}: ${address}`} title={saveLabel} onClick={(event) => { event.stopPropagation(); onSaveRecipient(address) }}><IconBookmarkPlus aria-hidden="true" size={13} stroke={1.8} /></button> : null}
            {savedRecipient ? <span className="recipient-chip-saved" title={savedLabel}><IconBookmark aria-hidden="true" size={12} stroke={1.8} /></span> : null}
            <button type="button" className="recipient-chip-action" aria-label={`${removeLabel}: ${address}`} title={removeLabel} onClick={(event) => { event.stopPropagation(); removeRecipient(index) }}><IconX aria-hidden="true" size={13} stroke={2} /></button>
          </span>
        )
      })}
      <Input
        ref={inputRef}
        id={id}
        className="recipient-input-field"
        type="text"
        inputMode="email"
        value={draft}
        onFocus={() => setIsInputFocused(true)}
        onBlur={() => setIsInputFocused(false)}
        onChange={(event) => updateDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === ',' || event.key === ';') {
            event.preventDefault()
            commitAddress()
          } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
            event.preventDefault()
            setActiveSuggestion((current) => (current + 1) % suggestions.length)
          } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
            event.preventDefault()
            setActiveSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length)
          } else if (event.key === 'Enter' && suggestions.length > 0) {
            event.preventDefault()
            selectSuggestion(suggestions[activeSuggestion] ?? suggestions[0])
          } else if ((event.key === 'Enter' || event.key === 'Tab') && draft.trim()) {
            if (event.key === 'Enter') event.preventDefault()
            commitAddress()
          } else if (event.key === 'Backspace' && !draft && committed.length > 0) {
            removeRecipient(committed.length - 1)
          }
        }}
        placeholder={committed.length === 0 ? placeholder : undefined}
        aria-invalid={invalid}
        aria-autocomplete="list"
        aria-controls={suggestions.length > 0 ? listId : undefined}
      />
      {suggestions.length > 0 ? <div className="recipient-suggestions" id={listId} role="listbox" aria-label={suggestionsLabel}>
        {suggestions.map((suggestion, index) => <button className={cn('recipient-suggestion', index === activeSuggestion && 'is-active')} key={suggestion.id} type="button" role="option" aria-selected={index === activeSuggestion} onMouseDown={(event) => event.preventDefault()} onClick={() => selectSuggestion(suggestion)}>
          <span className="recipient-suggestion-avatar">{suggestion.name.charAt(0).toUpperCase() || suggestion.email.charAt(0).toUpperCase()}</span>
          <span className="recipient-suggestion-copy"><strong>{suggestion.name || suggestion.email}</strong><span>{suggestion.email}</span></span>
          <IconBookmark aria-hidden="true" size={14} stroke={1.8} />
        </button>)}
      </div> : null}
    </div>
  )
}
