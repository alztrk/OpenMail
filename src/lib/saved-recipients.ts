import type { SavedRecipient } from '@/components/mail/recipient-input'

const STORAGE_KEY = 'openmail.saved-recipients'

function isSavedRecipient(value: unknown): value is SavedRecipient {
  if (typeof value !== 'object' || value === null) return false
  const recipient = value as Record<string, unknown>
  return typeof recipient.id === 'string'
    && typeof recipient.email === 'string'
    && typeof recipient.name === 'string'
    && typeof recipient.updatedAt === 'string'
}

export function loadSavedRecipients(): SavedRecipient[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter(isSavedRecipient).sort(sortRecipients) : []
  } catch {
    return []
  }
}

export function saveRecipient(email: string): SavedRecipient[] {
  const normalizedEmail = email.trim().toLowerCase()
  const recipients = loadSavedRecipients()
  const existing = recipients.find((recipient) => recipient.email.toLowerCase() === normalizedEmail)
  const nextRecipient: SavedRecipient = {
    id: existing?.id ?? `recipient-${crypto.randomUUID()}`,
    email: normalizedEmail,
    name: existing?.name ?? normalizedEmail,
    updatedAt: new Date().toISOString(),
  }
  const nextRecipients = [nextRecipient, ...recipients.filter((recipient) => recipient.id !== nextRecipient.id)].sort(sortRecipients)
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecipients))
  return nextRecipients
}

function sortRecipients(left: SavedRecipient, right: SavedRecipient): number {
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
}
