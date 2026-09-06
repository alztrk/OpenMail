import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconAdjustmentsHorizontal, IconBell, IconLanguage, IconPalette } from '@tabler/icons-react'
import type { AppSettings, ClockFormat, Density, ThemeMode } from '@/settings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type SettingsPanelProps = {
  settings: AppSettings
  onChange: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void
}

function SettingRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><span>{description}</span></div>{children}</div>
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const { t, i18n } = useTranslation()
  const [activeTab, setActiveTab] = useState<'general' | 'appearance' | 'language' | 'notifications'>('general')

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : settings.theme === 'system' ? 'dark' : settings.theme
    document.documentElement.style.setProperty('--app-font-scale', String(settings.fontScale))
    document.documentElement.style.setProperty('--reader-font-scale', String(settings.readerFontScale))
    document.documentElement.style.setProperty('--mail-sidebar-width', `${settings.sidebarWidth}px`)
    document.documentElement.style.setProperty('--reader-content-width', `${settings.readerWidth}px`)
    document.documentElement.dataset.density = settings.density
  }, [settings])

  const updateLanguage = (language: 'en' | 'tr') => {
    onChange('language', language)
    void i18n.changeLanguage(language)
  }

  const tabs = [
    { id: 'general' as const, label: t('generalSettings'), icon: IconAdjustmentsHorizontal },
    { id: 'appearance' as const, label: t('appearanceSettings'), icon: IconPalette },
    { id: 'language' as const, label: t('languageSettings'), icon: IconLanguage },
    { id: 'notifications' as const, label: t('notificationSettings'), icon: IconBell },
  ]

  return <div className="settings-layout">
    <aside className="settings-sidebar" aria-label={t('settings')}>
      <div className="settings-sidebar-title">{t('settings')}</div>
      <nav className="settings-tabs" aria-label={t('settings')}>
        {tabs.map((tab) => { const Icon = tab.icon; return <button className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`} key={tab.id} type="button" aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => setActiveTab(tab.id)}><Icon className="settings-tab-icon" aria-hidden="true" size={17} stroke={1.8} />{tab.label}</button> })}
      </nav>
    </aside>
    <div className="settings-content">
      <header className="settings-heading"><h2>{tabs.find((tab) => tab.id === activeTab)?.label}</h2><span>{t('settingsDescription')}</span></header>
      <div className="settings-sections">
      {activeTab === 'general' ? <section className="settings-section">
        <SettingRow label={t('launchAtStartup')} description={t('launchAtStartupDescription')}><input className="setting-toggle" type="checkbox" checked={settings.launchAtStartup} onChange={(e) => onChange('launchAtStartup', e.target.checked)} /></SettingRow>
        <SettingRow label={t('minimizeToTray')} description={t('minimizeToTrayDescription')}><input className="setting-toggle" type="checkbox" checked={settings.minimizeToTray} onChange={(e) => onChange('minimizeToTray', e.target.checked)} /></SettingRow>
        <SettingRow label={t('closeToTray')} description={t('closeToTrayDescription')}><input className="setting-toggle" type="checkbox" checked={settings.closeToTray} onChange={(e) => onChange('closeToTray', e.target.checked)} /></SettingRow>
        <SettingRow label={t('confirmOnClose')} description={t('confirmOnCloseDescription')}><input className="setting-toggle" type="checkbox" checked={settings.confirmOnClose} onChange={(e) => onChange('confirmOnClose', e.target.checked)} /></SettingRow>
        <SettingRow label={t('confirmActions')} description={t('confirmActionsDescription')}><input className="setting-toggle" type="checkbox" checked={settings.confirmActions} onChange={(e) => onChange('confirmActions', e.target.checked)} /></SettingRow>
      </section> : null}
      {activeTab === 'appearance' ? <section className="settings-section">
        <SettingRow label={t('theme')} description={t('themeDescription')}><Select value={settings.theme} onValueChange={(value) => onChange('theme', value as ThemeMode)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dark">{t('dark')}</SelectItem><SelectItem value="light">{t('light')}</SelectItem><SelectItem value="system">{t('system')}</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('density')} description={t('densityDescription')}><Select value={settings.density} onValueChange={(value) => onChange('density', value as Density)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="compact">{t('compact')}</SelectItem><SelectItem value="comfortable">{t('comfortable')}</SelectItem><SelectItem value="spacious">{t('spacious')}</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('globalFontSize')} description={t('globalFontSizeDescription')}><input type="range" min="0.9" max="1.2" step="0.05" value={settings.fontScale} onChange={(e) => onChange('fontScale', Number(e.target.value))} /></SettingRow>
        <SettingRow label={t('readerFontSize')} description={t('readerFontSizeDescription')}><input type="range" min="0.9" max="1.3" step="0.05" value={settings.readerFontScale} onChange={(e) => onChange('readerFontScale', Number(e.target.value))} /></SettingRow>
        <SettingRow label={t('sidebarWidth')} description={t('sidebarWidthDescription')}><input type="range" min="280" max="420" step="4" value={settings.sidebarWidth} onChange={(e) => onChange('sidebarWidth', Number(e.target.value))} /></SettingRow>
        <SettingRow label={t('readerWidth')} description={t('readerWidthDescription')}><input type="range" min="560" max="1000" step="20" value={settings.readerWidth} onChange={(e) => onChange('readerWidth', Number(e.target.value))} /></SettingRow>
        <SettingRow label={t('dateFormat')} description={t('dateFormatDescription')}><Select value={settings.dateFormat} onValueChange={(value) => onChange('dateFormat', value as AppSettings['dateFormat'])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">{t('system')}</SelectItem><SelectItem value="short">{t('shortDate')}</SelectItem><SelectItem value="long">{t('longDate')}</SelectItem></SelectContent></Select></SettingRow>
      </section> : null}
      {activeTab === 'language' ? <section className="settings-section">
        <SettingRow label={t('language')} description={t('languageDescription')}><Select value={settings.language} onValueChange={(value) => updateLanguage(value as 'en' | 'tr')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="en">English</SelectItem><SelectItem value="tr">Türkçe</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('clockFormat')} description={t('clockFormatDescription')}><Select value={settings.clockFormat} onValueChange={(value) => onChange('clockFormat', value as ClockFormat)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="12">12:00 PM</SelectItem><SelectItem value="24">24:00</SelectItem></SelectContent></Select></SettingRow>
      </section> : null}
      {activeTab === 'notifications' ? <section className="settings-section">
        <SettingRow label={t('notificationsEnabled')} description={t('notificationsEnabledDescription')}><input className="setting-toggle" type="checkbox" checked={settings.notificationsEnabled} onChange={(e) => onChange('notificationsEnabled', e.target.checked)} /></SettingRow>
        <SettingRow label={t('notificationSound')} description={t('notificationSoundDescription')}><input className="setting-toggle" type="checkbox" checked={settings.notificationSound} disabled={!settings.notificationsEnabled} onChange={(e) => onChange('notificationSound', e.target.checked)} /></SettingRow>
        <SettingRow label={t('notificationSoundName')} description={t('notificationSoundNameDescription')}><Select value={settings.notificationSoundName} disabled={!settings.notificationsEnabled || !settings.notificationSound} onValueChange={(value) => onChange('notificationSoundName', value as AppSettings['notificationSoundName'])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">{t('defaultSound')}</SelectItem><SelectItem value="soft">{t('softSound')}</SelectItem><SelectItem value="none">{t('noSound')}</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('quietHours')} description={t('quietHoursDescription')}><input className="setting-toggle" type="checkbox" checked={settings.quietHoursEnabled} onChange={(e) => onChange('quietHoursEnabled', e.target.checked)} /></SettingRow>
        {settings.quietHoursEnabled ? <div className="time-range"><label>{t('quietHoursStart')}<input type="time" value={settings.quietHoursStart} onChange={(e) => onChange('quietHoursStart', e.target.value)} /></label><label>{t('quietHoursEnd')}<input type="time" value={settings.quietHoursEnd} onChange={(e) => onChange('quietHoursEnd', e.target.value)} /></label></div> : null}
      </section> : null}
    </div>
    </div>
  </div>
}
