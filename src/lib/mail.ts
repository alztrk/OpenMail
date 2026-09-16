export function getSenderLabel(sender: string, address: string): string {
  return sender.trim() || address.trim() || '?'
}

export function getMessageIdentity(message: { id: string; account_id?: string }, fallbackAccountId?: string): string {
  return `${message.account_id ?? fallbackAccountId ?? 'unknown'}:${message.id}`
}

export function getMessageTimeValue(value: string): number {
  return new Date(/^\d+$/.test(value) ? Number(value) : value).getTime()
}

export function compareMessageTimes(left: string, right: string): number {
  const leftTime = getMessageTimeValue(left)
  const rightTime = getMessageTimeValue(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime
  if (Number.isFinite(leftTime)) return -1
  if (Number.isFinite(rightTime)) return 1
  return right.localeCompare(left)
}
