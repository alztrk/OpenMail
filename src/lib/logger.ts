import { debug, error, info, warn } from '@tauri-apps/plugin-log'

type LogValue = boolean | number | string | null
type LogFields = Readonly<Record<string, LogValue | undefined>>
type LogWriter = (message: string) => Promise<void>

const MAX_FIELD_LENGTH = 160

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function normalizeFieldValue(value: LogValue | undefined): LogValue | undefined {
  if (typeof value !== 'string' || value.length <= MAX_FIELD_LENGTH) return value
  return `${value.slice(0, MAX_FIELD_LENGTH)}…`
}

function formatMessage(event: string, fields: LogFields): string {
  const normalizedFields = Object.fromEntries(
    Object.entries(fields)
      .map(([key, value]) => [key, normalizeFieldValue(value)] as const)
      .filter(([, value]) => value !== undefined),
  )
  const serializedFields = Object.keys(normalizedFields).length > 0 ? ` ${JSON.stringify(normalizedFields)}` : ''
  return `[frontend] ${event}${serializedFields}`
}

function writeLog(writer: LogWriter, event: string, fields: LogFields): void {
  if (!isTauriRuntime()) return
  void writer(formatMessage(event, fields)).catch(() => {
    // Logging is best effort and must never interrupt the user-facing mail flow.
  })
}

export function logDebug(event: string, fields: LogFields = {}): void {
  writeLog(debug, event, fields)
}

export function logInfo(event: string, fields: LogFields = {}): void {
  writeLog(info, event, fields)
}

export function logWarn(event: string, fields: LogFields = {}): void {
  writeLog(warn, event, fields)
}

export function logError(event: string, fields: LogFields = {}): void {
  writeLog(error, event, fields)
}

export function getErrorType(value: unknown): string {
  if (value instanceof Error && value.name) return value.name
  if (typeof value === 'string') return 'string_error'
  return 'unknown_error'
}

export function logPerformance(event: string, durationMs: number, fields: LogFields = {}): void {
  logInfo(`performance.${event}`, {
    ...fields,
    duration_ms: Math.round(durationMs),
  })
}
