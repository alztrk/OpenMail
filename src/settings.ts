export type ThemeMode = 'dark' | 'light' | 'system'
export type Density = 'compact' | 'comfortable' | 'spacious'
export type ClockFormat = '12' | '24'

export type AppSettings = {
  launchAtStartup: boolean
  minimizeToTray: boolean
  closeToTray: boolean
  confirmOnClose: boolean
  confirmActions: boolean
  theme: ThemeMode
  density: Density
  fontScale: number
  readerFontScale: number
  dateFormat: 'system' | 'short' | 'long'
  clockFormat: ClockFormat
  language: 'en' | 'tr'
  notificationsEnabled: boolean
  notificationSound: boolean
  notificationSoundName: 'default' | 'soft' | 'none'
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
}

export const defaultSettings: AppSettings = {
  launchAtStartup: false, minimizeToTray: true, closeToTray: false, confirmOnClose: true, confirmActions: true,
  theme: 'dark', density: 'comfortable', fontScale: 1, readerFontScale: 1,
  dateFormat: 'system', clockFormat: '24', language: 'en', notificationsEnabled: true, notificationSound: true,
  notificationSoundName: 'default', quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00',
}

const storageKey = 'openmail.settings'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function clampScale(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback
}

function normalizeSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return defaultSettings
  return {
    launchAtStartup: typeof value.launchAtStartup === 'boolean' ? value.launchAtStartup : defaultSettings.launchAtStartup,
    minimizeToTray: typeof value.minimizeToTray === 'boolean' ? value.minimizeToTray : defaultSettings.minimizeToTray,
    closeToTray: typeof value.closeToTray === 'boolean' ? value.closeToTray : defaultSettings.closeToTray,
    confirmOnClose: typeof value.confirmOnClose === 'boolean' ? value.confirmOnClose : defaultSettings.confirmOnClose,
    confirmActions: typeof value.confirmActions === 'boolean' ? value.confirmActions : defaultSettings.confirmActions,
    theme: value.theme === 'dark' || value.theme === 'light' || value.theme === 'system' ? value.theme : defaultSettings.theme,
    density: value.density === 'compact' || value.density === 'comfortable' || value.density === 'spacious' ? value.density : defaultSettings.density,
    fontScale: clampScale(value.fontScale, 0.9, 1.2, defaultSettings.fontScale),
    readerFontScale: clampScale(value.readerFontScale, 0.9, 1.3, defaultSettings.readerFontScale),
    dateFormat: value.dateFormat === 'system' || value.dateFormat === 'short' || value.dateFormat === 'long' ? value.dateFormat : defaultSettings.dateFormat,
    clockFormat: value.clockFormat === '12' || value.clockFormat === '24' ? value.clockFormat : defaultSettings.clockFormat,
    language: value.language === 'en' || value.language === 'tr' ? value.language : defaultSettings.language,
    notificationsEnabled: typeof value.notificationsEnabled === 'boolean' ? value.notificationsEnabled : defaultSettings.notificationsEnabled,
    notificationSound: typeof value.notificationSound === 'boolean' ? value.notificationSound : defaultSettings.notificationSound,
    notificationSoundName: value.notificationSoundName === 'default' || value.notificationSoundName === 'soft' || value.notificationSoundName === 'none' ? value.notificationSoundName : defaultSettings.notificationSoundName,
    quietHoursEnabled: typeof value.quietHoursEnabled === 'boolean' ? value.quietHoursEnabled : defaultSettings.quietHoursEnabled,
    quietHoursStart: typeof value.quietHoursStart === 'string' ? value.quietHoursStart : defaultSettings.quietHoursStart,
    quietHoursEnd: typeof value.quietHoursEnd === 'string' ? value.quietHoursEnd : defaultSettings.quietHoursEnd,
  }
}

export function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(storageKey)
    return stored ? normalizeSettings(JSON.parse(stored)) : defaultSettings
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(storageKey, JSON.stringify(settings))
}
