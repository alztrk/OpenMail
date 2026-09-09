export function getSenderLabel(sender: string, address: string): string {
  return sender.trim() || address.trim() || '?'
}
