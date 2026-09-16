export function formatFileSize(size: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  if (size < 1024) return `${formatter.format(size)} B`
  if (size < 1024 * 1024) return `${formatter.format(Math.round(size / 1024))} KB`
  return `${formatter.format(size / (1024 * 1024))} MB`
}
