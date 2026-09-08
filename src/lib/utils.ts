export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export function isValidEmailAddress(value: string): boolean {
  const address = value.trim()
  if (!address || /\s/.test(address)) return false
  const separatorIndex = address.indexOf('@')
  return separatorIndex > 0 && separatorIndex === address.lastIndexOf('@') && separatorIndex < address.length - 1
}

export function splitEmailAddresses(value: string): string[] {
  return value.split(/[;,]/).map((address) => address.trim()).filter(Boolean)
}

export function areValidEmailAddresses(value: string): boolean {
  const addresses = splitEmailAddresses(value)
  return addresses.length > 0 && addresses.every(isValidEmailAddress)
}
