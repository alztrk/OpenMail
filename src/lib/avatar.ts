const AVATAR_TONE_COUNT = 4

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
