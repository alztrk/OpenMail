import { cloneElement, isValidElement, type KeyboardEvent, type ReactElement, type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconAdjustmentsHorizontal, IconBell, IconLanguage, IconPalette, IconRefresh, IconTrash, IconUser, IconUserPlus } from '@tabler/icons-react'
import type { AppSettings, ClockFormat, Density, ThemeMode } from '@/settings'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

type SettingsPanelProps = {
  settings: AppSettings
  onChange: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void
  accounts: MailAccount[]
  providerLogos: Record<MailAccount['provider'], string>
  defaultAccountId: string
  onSetDefault: (accountId: string) => void
  onRemoveAccount: (accountId: string) => void
  onStartGmailAuth: (loginHint?: string) => Promise<unknown>
  onError: (error: unknown) => void
}

type MailAccount = {
  id: string
  address: string
  provider: 'gmail' | 'outlook'
  is_default: boolean
}

function SettingRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  const labelId = useId()
  const descriptionId = useId()
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string; 'aria-labelledby'?: string }>, { 'aria-describedby': descriptionId, 'aria-labelledby': labelId })
    : children
  return <div className="setting-row"><div><strong id={labelId}>{label}</strong><span id={descriptionId}>{description}</span></div>{control}</div>
}

export function SettingsPanel({ settings, onChange, accounts, providerLogos, defaultAccountId, onSetDefault, onRemoveAccount, onStartGmailAuth, onError }: SettingsPanelProps) {
  const { t, i18n } = useTranslation()
  const [activeTab, setActiveTab] = useState<'general' | 'appearance' | 'language' | 'notifications' | 'accounts'>(accounts.length === 0 ? 'accounts' : 'general')
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false)
  const [accountToRemoveId, setAccountToRemoveId] = useState<string | null>(null)
  const [reconnectingAccountId, setReconnectingAccountId] = useState<string | null>(null)
  const [isAddingAccount, setIsAddingAccount] = useState(false)
  const [providerTab, setProviderTab] = useState<MailAccount['provider']>('gmail')

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number, count: number, selector: string) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + count) % count
    document.querySelector<HTMLButtonElement>(`${selector}[data-tab-index="${nextIndex}"]`)?.focus()
  }

  const updateLanguage = (language: 'en' | 'tr') => {
    onChange('language', language)
    void i18n.changeLanguage(language)
  }

  const reconnectAccount = async (account: MailAccount) => {
    if (account.provider !== 'gmail' || reconnectingAccountId) return
    setReconnectingAccountId(account.id)
    try {
      await onStartGmailAuth(account.address)
    } catch (error: unknown) {
      onError(error)
    } finally {
      setReconnectingAccountId(null)
    }
  }

  const tabs = [
    { id: 'general' as const, label: t('generalSettings'), icon: IconAdjustmentsHorizontal },
    { id: 'appearance' as const, label: t('appearanceSettings'), icon: IconPalette },
    { id: 'language' as const, label: t('languageSettings'), icon: IconLanguage },
    { id: 'notifications' as const, label: t('notificationSettings'), icon: IconBell },
    { id: 'accounts' as const, label: t('accountsSettings'), icon: IconUser },
  ]

  return <div className="settings-layout">
    <aside className="settings-sidebar" aria-label={t('settings')}>
      <div className="settings-sidebar-title">{t('settings')}</div>
      <nav className="settings-tabs" role="tablist" aria-label={t('settings')}>
        {tabs.map((tab, index) => { const Icon = tab.icon; return <button className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`} key={tab.id} id={`settings-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="settings-panel" tabIndex={activeTab === tab.id ? 0 : -1} data-tab-index={index} onKeyDown={(event) => moveTabFocus(event, index, tabs.length, '.settings-tab')} onClick={() => setActiveTab(tab.id)}><Icon className="settings-tab-icon" aria-hidden="true" size={17} stroke={1.8} />{tab.label}</button> })}
      </nav>
    </aside>
    <div className="settings-content">
      <header className="settings-heading">
        <div className="settings-heading-copy"><h2 id="settings-title">{tabs.find((tab) => tab.id === activeTab)?.label}</h2><span>{activeTab === 'accounts' ? t('accountsSettingsDescription') : t('settingsDescription')}</span></div>
        {activeTab === 'accounts' ? <div className="accounts-heading-actions"><Button className="account-add-button" onClick={() => setIsAddAccountOpen(true)} aria-haspopup="dialog"><IconUserPlus aria-hidden="true" size={16} stroke={1.8} />{t('addAccount')}</Button></div> : null}
      </header>
      <div className="settings-sections" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
      {activeTab === 'general' ? <section className="settings-section">
        <SettingRow label={t('launchAtStartup')} description={t('launchAtStartupDescription')}><Switch className="setting-toggle" aria-label={t('launchAtStartup')} checked={settings.launchAtStartup} onChange={(e) => onChange('launchAtStartup', e.target.checked)} /></SettingRow>
        <SettingRow label={t('minimizeToTray')} description={t('minimizeToTrayDescription')}><Switch className="setting-toggle" aria-label={t('minimizeToTray')} checked={settings.minimizeToTray} onChange={(e) => onChange('minimizeToTray', e.target.checked)} /></SettingRow>
        <SettingRow label={t('closeToTray')} description={t('closeToTrayDescription')}><Switch className="setting-toggle" aria-label={t('closeToTray')} checked={settings.closeToTray} onChange={(e) => onChange('closeToTray', e.target.checked)} /></SettingRow>
        <SettingRow label={t('confirmOnClose')} description={t('confirmOnCloseDescription')}><Switch className="setting-toggle" aria-label={t('confirmOnClose')} checked={settings.confirmOnClose} onChange={(e) => onChange('confirmOnClose', e.target.checked)} /></SettingRow>
        <SettingRow label={t('confirmActions')} description={t('confirmActionsDescription')}><Switch className="setting-toggle" aria-label={t('confirmActions')} checked={settings.confirmActions} onChange={(e) => onChange('confirmActions', e.target.checked)} /></SettingRow>
      </section> : null}
      {activeTab === 'appearance' ? <section className="settings-section">
        <SettingRow label={t('theme')} description={t('themeDescription')}><Select value={settings.theme} onValueChange={(value) => onChange('theme', value as ThemeMode)}><SelectTrigger aria-label={t('theme')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dark">{t('dark')}</SelectItem><SelectItem value="light">{t('light')}</SelectItem><SelectItem value="system">{t('system')}</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('density')} description={t('densityDescription')}><Select value={settings.density} onValueChange={(value) => onChange('density', value as Density)}><SelectTrigger aria-label={t('density')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="compact">{t('compact')}</SelectItem><SelectItem value="comfortable">{t('comfortable')}</SelectItem><SelectItem value="spacious">{t('spacious')}</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('globalFontSize')} description={t('globalFontSizeDescription')}><Slider aria-label={t('globalFontSize')} min="0.9" max="1.2" step="0.05" value={settings.fontScale} onChange={(e) => onChange('fontScale', Number(e.target.value))} /></SettingRow>
        <SettingRow label={t('readerFontSize')} description={t('readerFontSizeDescription')}><Slider aria-label={t('readerFontSize')} min="0.9" max="1.3" step="0.05" value={settings.readerFontScale} onChange={(e) => onChange('readerFontScale', Number(e.target.value))} /></SettingRow>
        <SettingRow label={t('dateFormat')} description={t('dateFormatDescription')}><Select value={settings.dateFormat} onValueChange={(value) => onChange('dateFormat', value as AppSettings['dateFormat'])}><SelectTrigger aria-label={t('dateFormat')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">{t('system')}</SelectItem><SelectItem value="short">{t('shortDate')}</SelectItem><SelectItem value="long">{t('longDate')}</SelectItem></SelectContent></Select></SettingRow>
      </section> : null}
      {activeTab === 'language' ? <section className="settings-section">
        <SettingRow label={t('language')} description={t('languageDescription')}><Select value={settings.language} onValueChange={(value) => updateLanguage(value as 'en' | 'tr')}><SelectTrigger aria-label={t('language')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="en">{t('englishLanguage')}</SelectItem><SelectItem value="tr">{t('turkishLanguage')}</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('clockFormat')} description={t('clockFormatDescription')}><Select value={settings.clockFormat} onValueChange={(value) => onChange('clockFormat', value as ClockFormat)}><SelectTrigger aria-label={t('clockFormat')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="12">{t('clockFormat12Example')}</SelectItem><SelectItem value="24">{t('clockFormat24Example')}</SelectItem></SelectContent></Select></SettingRow>
      </section> : null}
      {activeTab === 'notifications' ? <section className="settings-section">
        <SettingRow label={t('notificationsEnabled')} description={t('notificationsEnabledDescription')}><Switch className="setting-toggle" aria-label={t('notificationsEnabled')} checked={settings.notificationsEnabled} onChange={(e) => onChange('notificationsEnabled', e.target.checked)} /></SettingRow>
        <SettingRow label={t('notificationSound')} description={t('notificationSoundDescription')}><Switch className="setting-toggle" aria-label={t('notificationSound')} checked={settings.notificationSound} disabled={!settings.notificationsEnabled} onChange={(e) => onChange('notificationSound', e.target.checked)} /></SettingRow>
        <SettingRow label={t('notificationSoundName')} description={t('notificationSoundNameDescription')}><Select value={settings.notificationSoundName} disabled={!settings.notificationsEnabled || !settings.notificationSound} onValueChange={(value) => onChange('notificationSoundName', value as AppSettings['notificationSoundName'])}><SelectTrigger aria-label={t('notificationSoundName')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">{t('defaultSound')}</SelectItem><SelectItem value="soft">{t('softSound')}</SelectItem><SelectItem value="none">{t('noSound')}</SelectItem></SelectContent></Select></SettingRow>
        <SettingRow label={t('quietHours')} description={t('quietHoursDescription')}><Switch className="setting-toggle" aria-label={t('quietHours')} checked={settings.quietHoursEnabled} onChange={(e) => onChange('quietHoursEnabled', e.target.checked)} /></SettingRow>
        {settings.quietHoursEnabled ? <div className="time-range"><label>{t('quietHoursStart')}<Input type="time" value={settings.quietHoursStart} onChange={(e) => onChange('quietHoursStart', e.target.value)} /></label><label>{t('quietHoursEnd')}<Input type="time" value={settings.quietHoursEnd} onChange={(e) => onChange('quietHoursEnd', e.target.value)} /></label></div> : null}
      </section> : null}
      {activeTab === 'accounts' ? <section className="settings-section accounts-section">
        <div className="account-settings-list">
          {accounts.length > 0 ? accounts.map((account) => (
            <article className="account-settings-row" key={account.id}>
              <div className="account-settings-identity">
                <span className="account-settings-logo"><img src={providerLogos[account.provider]} alt="" /></span>
                <div><strong>{account.address}</strong><span>{t(account.provider)} · {t('accountConnected')}</span></div>
              </div>
              <div className="account-settings-meta">
                {account.id === defaultAccountId ? <span className="account-default-badge">{t('defaultAccount')}</span> : null}
                <div className="account-settings-actions">
                  {account.id !== defaultAccountId ? <Button className="account-default-action" variant="ghost" onClick={() => onSetDefault(account.id)}>{t('setDefault')}</Button> : null}
                  <Button className="account-settings-action" variant="ghost" size="icon" disabled={account.provider !== 'gmail' || reconnectingAccountId !== null} aria-label={t('reconnectAccount')} title={t('reconnectAccount')} onClick={() => { void reconnectAccount(account) }}><IconRefresh aria-hidden="true" size={16} stroke={1.8} /></Button>
                  <Button className="account-settings-action" variant="ghost" size="icon" aria-label={t('removeAccount')} title={t('removeAccount')} onClick={() => setAccountToRemoveId(account.id)}><IconTrash aria-hidden="true" size={16} stroke={1.8} /></Button>
                </div>
              </div>
            </article>
          )) : <div className="accounts-empty-state"><IconUser size={22} stroke={1.8} aria-hidden="true" /><strong>{t('noConnectedAccounts')}</strong><span>{t('noConnectedAccountsDescription')}</span></div>}
        </div>
      </section> : null}
      </div>
    </div>
    <Dialog open={isAddAccountOpen} title={t('addAccount')} closeLabel={t('close')} onClose={() => setIsAddAccountOpen(false)}>
      <div className="provider-tabs" role="tablist" aria-label={t('accountProviderTabs')}>
        {(['gmail', 'outlook'] as const).map((provider) => (
            <button className={`provider-tab ${providerTab === provider ? 'active' : ''}`} key={provider} id={`provider-tab-${provider}`} type="button" role="tab" aria-selected={providerTab === provider} aria-controls="provider-panel" tabIndex={providerTab === provider ? 0 : -1} data-tab-index={provider === 'gmail' ? 0 : 1} autoFocus={provider === 'gmail'} onKeyDown={(event) => moveTabFocus(event, provider === 'gmail' ? 0 : 1, 2, '.provider-tab')} onClick={() => setProviderTab(provider)} disabled={isAddingAccount}>
            <img src={providerLogos[provider]} alt="" />
            {t(provider)}
          </button>
        ))}
      </div>
      <div className="provider-tab-panel" id="provider-panel" role="tabpanel" aria-labelledby={`provider-tab-${providerTab}`} aria-label={t(providerTab)}>
        {providerTab === 'gmail' ? <Button type="button" disabled={isAddingAccount} onClick={() => { setIsAddingAccount(true); void onStartGmailAuth().then(() => setIsAddAccountOpen(false)).catch((error: unknown) => onError(error)).finally(() => setIsAddingAccount(false)) }}>{isAddingAccount ? t('connecting') : t('continueWithGmail')}</Button> : <div className="provider-unavailable"><strong>{t('providerComingSoon')}</strong><span>{t('providerComingSoonDescription')}</span></div>}
      </div>
    </Dialog>
    <Dialog open={accountToRemoveId !== null} title={t('removeAccount')} closeLabel={t('close')} onClose={() => setAccountToRemoveId(null)}>
      <div className="account-remove-dialog-content">
        <p>{t('confirmRemoveAccount')}</p>
        <div className="confirm-dialog-actions">
          <Button variant="ghost" type="button" onClick={() => setAccountToRemoveId(null)}>{t('cancel')}</Button>
          <Button variant="danger" type="button" onClick={() => { if (accountToRemoveId) onRemoveAccount(accountToRemoveId); setAccountToRemoveId(null) }}>{t('removeAccount')}</Button>
        </div>
      </div>
    </Dialog>
  </div>
}
