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
  sidebarWidth: number
  readerWidth: number
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
  theme: 'dark', density: 'comfortable', fontScale: 1, readerFontScale: 1, sidebarWidth: 332, readerWidth: 760,
  dateFormat: 'system', clockFormat: '24', language: 'en', notificationsEnabled: true, notificationSound: true,
  notificationSoundName: 'default', quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00',
}

const storageKey = 'openmail.settings'

export function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(storageKey)
    return stored ? { ...defaultSettings, ...JSON.parse(stored) as Partial<AppSettings> } : defaultSettings
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(storageKey, JSON.stringify(settings))
}
