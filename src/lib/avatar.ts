const AVATAR_TONE_COUNT = 4
const FAVICON_URL = 'https://www.google.com/s2/favicons'

export function getSenderAvatarInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    return `${Array.from(words[0])[0] ?? ''}${Array.from(words[1])[0] ?? ''}`.toUpperCase()
  }
  return Array.from(words[0] ?? '?').slice(0, 2).join('').toUpperCase()
}

export function getSenderAvatarTone(label: string, address?: string | null): number {
  const value = (address?.trim() || label.trim() || '?').toLowerCase()
  let hash = 0
  for (const character of value) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0
  return Math.abs(hash) % AVATAR_TONE_COUNT
}

export function getSenderAvatarUrl(address?: string | null): string | null {
  const normalizedAddress = address?.trim().toLowerCase() ?? ''
  const atIndex = normalizedAddress.lastIndexOf('@')
  if (atIndex < 1 || atIndex === normalizedAddress.length - 1) return null

  const domain = normalizedAddress.slice(atIndex + 1)
  if (!isValidAvatarDomain(domain)) return null

  return `${FAVICON_URL}?domain=${encodeURIComponent(domain)}&sz=64`
}

function isValidAvatarDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253 || domain.startsWith('.') || domain.endsWith('.')) return false

  return domain.split('.').every((label) => {
    if (label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-')) return false
    return Array.from(label).every((character) => /[a-z0-9-]/.test(character))
  })
}
