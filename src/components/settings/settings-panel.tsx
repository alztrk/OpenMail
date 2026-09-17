import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconAdjustmentsHorizontal, IconArrowLeft, IconBell, IconChevronRight, IconKey, IconLanguage, IconMailPlus, IconPalette, IconRefresh, IconTrash, IconUser } from '@tabler/icons-react'
import { invoke } from '@tauri-apps/api/core'
import type { AppSettings, ClockFormat, Density, ThemeMode } from '@/settings'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { isSupportedLocale, localeOptions, type SupportedLocale } from '@/locale-config'

type SettingsPanelProps = {
  settings: AppSettings
  onChange: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => boolean
  accounts: MailAccount[]
  providerLogos: Record<MailAccount['provider'], string>
  defaultAccountId: string
  onSetDefault: (accountId: string) => void
  onRemoveAccount: (accountId: string) => void
  onStartAuth: (provider: MailAccount['provider'], loginHint?: string) => Promise<unknown>
  onError: (error: unknown) => void
  onBackToMail: () => void
  isAddAccountOpen: boolean
  onAddAccountOpenChange: (open: boolean) => void
  isAccountMutationInFlight: boolean
  notificationPermission: NotificationPermissionState
  onRequestNotificationPermission: () => Promise<boolean>
  appLockConfigured: boolean
  onConfigureAppLock: () => Promise<void>
  onDisableAppLock: () => Promise<void>
  onExportBackup: () => Promise<void>
  onImportBackup: () => Promise<void>
  appVersion: string
  updateState: UpdateState
  updateAvailableVersion: string | null
  updateProgress: number | null
  onCheckForUpdates: () => Promise<void>
  onInstallUpdate: () => Promise<void>
}

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'upToDate' | 'unavailable' | 'error'

type NotificationPermissionState = 'unknown' | 'granted' | 'denied' | 'requesting'

type OAuthProviderCredentialStatus = {
  client_id: boolean
  client_secret: boolean
}

type OAuthCredentialStatus = {
  gmail: OAuthProviderCredentialStatus
  outlook: OAuthProviderCredentialStatus
}

type MailAccount = {
  id: string
  address: string
  provider: 'gmail' | 'outlook'
  is_default: boolean
}

type SettingControlIds = {
  labelId: string
  descriptionId: string
}

type SettingRowProps = {
  label: string
  description: string
  value?: string
  children: ReactNode | ((ids: SettingControlIds) => ReactNode)
}

function isThemeMode(value: string): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system'
}

function isDensity(value: string): value is Density {
  return value === 'compact' || value === 'comfortable' || value === 'spacious'
}

function isDateFormat(value: string): value is AppSettings['dateFormat'] {
  return value === 'system' || value === 'short' || value === 'long'
}

const isLanguage = isSupportedLocale

function isClockFormat(value: string): value is ClockFormat {
  return value === '12' || value === '24'
}

function isNotificationSoundName(value: string): value is AppSettings['notificationSoundName'] {
  return value === 'default' || value === 'soft' || value === 'none'
}

function SettingRow({ label, description, value, children }: SettingRowProps) {
  const labelId = useId()
  const descriptionId = useId()
  const control = typeof children === 'function'
    ? children({ labelId, descriptionId })
    : children
  return <div className="setting-row"><div className="setting-description"><strong id={labelId}>{label}</strong><span id={descriptionId}>{description}</span></div><div className="setting-control">{control}{value ? <output className="setting-value">{value}</output> : null}</div></div>
}

export function SettingsPanel({ settings, onChange, accounts, providerLogos, defaultAccountId, onSetDefault, onRemoveAccount, onStartAuth, onError, onBackToMail, isAddAccountOpen, onAddAccountOpenChange, isAccountMutationInFlight, notificationPermission, onRequestNotificationPermission, appLockConfigured, onConfigureAppLock, onDisableAppLock, onExportBackup, onImportBackup, appVersion, updateState, updateAvailableVersion, updateProgress, onCheckForUpdates, onInstallUpdate }: SettingsPanelProps) {
  const { t, i18n } = useTranslation()
  const [activeTab, setActiveTab] = useState<'general' | 'appearance' | 'language' | 'notifications' | 'accounts' | 'oauth'>(accounts.length === 0 ? 'accounts' : 'general')
  const [accountToRemoveId, setAccountToRemoveId] = useState<string | null>(null)
  const [reconnectingAccountId, setReconnectingAccountId] = useState<string | null>(null)
  const [isAddingAccount, setIsAddingAccount] = useState(false)
  const [addingProvider, setAddingProvider] = useState<MailAccount['provider'] | null>(null)
  const [oauthCredentialStatus, setOauthCredentialStatus] = useState<OAuthCredentialStatus | null>(null)
  const [oauthStatusError, setOauthStatusError] = useState(false)
  const [gmailClientId, setGmailClientId] = useState('')
  const [gmailClientSecret, setGmailClientSecret] = useState('')
  const [outlookClientId, setOutlookClientId] = useState('')
  const [savingOAuthProvider, setSavingOAuthProvider] = useState<MailAccount['provider'] | null>(null)
  const [oauthNotice, setOauthNotice] = useState('')
  const addAccountButtonRef = useRef<HTMLButtonElement>(null)
  const firstProviderButtonRef = useRef<HTMLButtonElement>(null)
  const isAuthInFlight = isAddingAccount || reconnectingAccountId !== null || isAccountMutationInFlight
  const isTauriRuntime = '__TAURI_INTERNALS__' in window

  const refreshOAuthCredentialStatus = useCallback(async () => {
    if (!isTauriRuntime) return
    try {
      const status = await invoke<OAuthCredentialStatus>('get_oauth_credential_status')
      setOauthCredentialStatus(status)
      setOauthStatusError(false)
    } catch (error: unknown) {
      setOauthStatusError(true)
      onError(error)
    }
  }, [isTauriRuntime, onError])

  useEffect(() => {
    // Credential Manager is an external system, so its status must be synchronized after mount.
    // oxlint-disable-next-line react/set-state-in-effect
    void refreshOAuthCredentialStatus()
  }, [refreshOAuthCredentialStatus])

  const isOAuthProviderConfigured = (provider: MailAccount['provider']) => {
    if (!oauthCredentialStatus) return false
    const status = oauthCredentialStatus[provider]
    return status.client_id && (provider === 'outlook' || status.client_secret)
  }

  const handleSaveOAuthCredentials = async (provider: MailAccount['provider']) => {
    const clientId = provider === 'gmail' ? gmailClientId.trim() : outlookClientId.trim()
    const clientSecret = provider === 'gmail' ? gmailClientSecret.trim() : null
    if (!clientId || (provider === 'gmail' && !clientSecret)) {
      onError(new Error(provider === 'gmail' ? 'OPENMAIL_GMAIL_CLIENT_SECRET_REQUIRED' : 'OPENMAIL_OAUTH_CLIENT_ID_REQUIRED'))
      return
    }
    setSavingOAuthProvider(provider)
    setOauthNotice('')
    try {
      const status = await invoke<OAuthCredentialStatus>('save_oauth_credentials', {
        provider,
        clientId,
        clientSecret,
      })
      setOauthCredentialStatus(status)
      setOauthNotice(t('oauthCredentialsSaved'))
      if (provider === 'gmail') setGmailClientSecret('')
    } catch (error: unknown) {
      onError(error)
    } finally {
      setSavingOAuthProvider(null)
    }
  }

  const handleClearOAuthCredentials = async (provider: MailAccount['provider']) => {
    setSavingOAuthProvider(provider)
    setOauthNotice('')
    try {
      const status = await invoke<OAuthCredentialStatus>('clear_oauth_credentials', { provider })
      setOauthCredentialStatus(status)
      setOauthNotice(t('oauthCredentialsRemoved'))
    } catch (error: unknown) {
      onError(error)
    } finally {
      setSavingOAuthProvider(null)
    }
  }
  const notificationPermissionLabel = notificationPermission === 'granted'
    ? t('notificationPermissionGranted')
    : notificationPermission === 'denied'
      ? t('notificationPermissionDenied')
      : notificationPermission === 'requesting'
        ? t('notificationPermissionRequesting')
        : t('notificationPermissionUnknown')

  const handleStartAuth = async (provider: MailAccount['provider']) => {
    if (isAddingAccount) return
    setIsAddingAccount(true)
    setAddingProvider(provider)
    try {
      await onStartAuth(provider)
      onAddAccountOpenChange(false)
    } catch (error: unknown) {
      onError(error)
    } finally {
      setIsAddingAccount(false)
      setAddingProvider(null)
    }
  }

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number, count: number, selector: string, selectTab: (nextIndex: number) => void) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + count) % count
    selectTab(nextIndex)
    document.querySelector<HTMLButtonElement>(`${selector}[data-tab-index="${nextIndex}"]`)?.focus()
  }

  const updateLanguage = (language: SupportedLocale) => {
    if (onChange('language', language)) void i18n.changeLanguage(language)
  }

  const reconnectAccount = async (account: MailAccount) => {
    if (reconnectingAccountId) return
    setReconnectingAccountId(account.id)
    try {
      await onStartAuth(account.provider, account.address)
    } catch (error: unknown) {
      onError(error)
    } finally {
      setReconnectingAccountId(null)
    }
  }


  const tabs = [
    { id: 'general' as const, label: t('generalSettings'), description: t('settingsGeneralDescription'), icon: IconAdjustmentsHorizontal },
    { id: 'appearance' as const, label: t('appearanceSettings'), description: t('settingsAppearanceDescription'), icon: IconPalette },
    { id: 'language' as const, label: t('languageSettings'), description: t('settingsLanguageDescription'), icon: IconLanguage },
    { id: 'notifications' as const, label: t('notificationSettings'), description: t('settingsNotificationsDescription'), icon: IconBell },
    { id: 'accounts' as const, label: t('accountsSettings'), description: t('accountsSettingsDescription'), icon: IconUser },
    { id: 'oauth' as const, label: t('oauthSettings'), description: t('oauthSettingsDescription'), icon: IconKey },
  ]
  const activeTabDetails = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]
  const ActiveTabIcon = activeTabDetails.icon

  return <div className="settings-layout">
    <aside className="settings-sidebar" aria-label={t('settings')}>
      <Button className="settings-back-button" variant="ghost" type="button" onClick={onBackToMail} aria-label={t('backToMailList')}><IconArrowLeft aria-hidden="true" size={16} stroke={1.8} />{t('backToMailList')}</Button>
      <h2 className="settings-sidebar-title" id="settings-navigation-title">{t('settings')}</h2>
      <nav className="settings-tabs" role="tablist" aria-labelledby="settings-navigation-title">
        {tabs.map((tab, index) => { const Icon = tab.icon; return <button className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`} key={tab.id} id={`settings-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="settings-panel" tabIndex={activeTab === tab.id ? 0 : -1} data-tab-index={index} onKeyDown={(event) => moveTabFocus(event, index, tabs.length, '.settings-tab', (nextIndex) => setActiveTab(tabs[nextIndex].id))} onClick={() => setActiveTab(tab.id)}><Icon className="settings-tab-icon" aria-hidden="true" size={17} stroke={1.8} />{tab.label}</button> })}
      </nav>
    </aside>
    <div className="settings-content">
      <header className="settings-heading">
        <div className="settings-heading-copy">
          <span className="settings-heading-icon" aria-hidden="true"><ActiveTabIcon size={18} stroke={1.9} /></span>
          <div className="settings-heading-text"><h1 id="settings-title">{activeTabDetails.label}</h1><span>{activeTabDetails.description}</span></div>
        </div>
        {activeTab === 'accounts' ? <div className="accounts-heading-actions"><Button ref={addAccountButtonRef} className="account-add-button" disabled={isAuthInFlight} onClick={() => onAddAccountOpenChange(true)} aria-haspopup="dialog"><IconMailPlus aria-hidden="true" size={16} stroke={1.8} />{t('addAccount')}</Button></div> : null}
      </header>
      <div className="settings-sections" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
      {activeTab === 'general' ? <section className="settings-section">
        <div className="settings-group-heading"><strong>{t('startupBehavior')}</strong><span>{t('startupBehaviorDescription')}</span></div>
        <SettingRow label={t('launchAtStartup')} description={t('launchAtStartupDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.launchAtStartup} onChange={(e) => onChange('launchAtStartup', e.target.checked)} />}</SettingRow>
        <SettingRow label={t('minimizeToTray')} description={t('minimizeToTrayDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.minimizeToTray} onChange={(e) => onChange('minimizeToTray', e.target.checked)} />}</SettingRow>
        <SettingRow label={t('closeToTray')} description={t('closeToTrayDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.closeToTray} onChange={(e) => onChange('closeToTray', e.target.checked)} />}</SettingRow>
        <div className="settings-group-heading"><strong>{t('confirmationSettings')}</strong><span>{t('confirmationSettingsDescription')}</span></div>
        <SettingRow label={t('confirmOnClose')} description={t('confirmOnCloseDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.confirmOnClose} onChange={(e) => onChange('confirmOnClose', e.target.checked)} />}</SettingRow>
        <SettingRow label={t('confirmActions')} description={t('confirmActionsDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.confirmActions} onChange={(e) => onChange('confirmActions', e.target.checked)} />}</SettingRow>
        <div className="settings-group-heading"><strong>{t('appLockGroup')}</strong><span>{t('appLockGroupDescription')}</span></div>
        <SettingRow label={t('appLock')} description={t('appLockDescription')}><div className="setting-inline-actions"><span className={`app-lock-status ${appLockConfigured ? 'configured' : ''}`}>{appLockConfigured ? t('appLockConfigured') : t('appLockNotConfigured')}</span><Button variant="ghost" type="button" onClick={() => { void (appLockConfigured ? onDisableAppLock() : onConfigureAppLock()) }}>{appLockConfigured ? t('disableAppLock') : t('configureAppLock')}</Button></div></SettingRow>
        <div className="settings-group-heading"><strong>{t('backupGroup')}</strong><span>{t('backupGroupDescription')}</span></div>
        <SettingRow label={t('backup')} description={t('backupDescription')}><div className="setting-inline-actions"><Button variant="ghost" type="button" onClick={() => { void onExportBackup() }}>{t('exportBackup')}</Button><Button variant="ghost" type="button" onClick={() => { void onImportBackup() }}>{t('importBackup')}</Button></div></SettingRow>
        <div className="settings-group-heading"><strong>{t('updatesGroup')}</strong><span>{t('updatesGroupDescription')}</span></div>
        <SettingRow label={t('applicationVersion')} description={t('applicationVersionDescription')} value={appVersion}>
          <div className="setting-inline-actions update-actions">
            {updateState === 'available' && updateAvailableVersion ? <span className="update-status available">{t('updateAvailable', { version: updateAvailableVersion })}</span> : null}
            {updateState === 'upToDate' ? <span className="update-status">{t('updateAlreadyLatest')}</span> : null}
            {updateState === 'error' ? <span className="update-status error">{t('updateCheckFailed')}</span> : null}
            {updateState === 'downloading' && updateProgress !== null ? <span className="update-status">{t('downloadingUpdate', { progress: updateProgress })}</span> : null}
            <Button variant="ghost" type="button" disabled={updateState === 'checking' || updateState === 'downloading'} onClick={() => { void onCheckForUpdates() }}>{updateState === 'checking' ? t('checkingForUpdates') : t('checkForUpdates')}</Button>
            {updateState === 'available' ? <Button type="button" onClick={() => { void onInstallUpdate() }}>{t('installUpdate')}</Button> : null}
          </div>
        </SettingRow>
      </section> : null}
      {activeTab === 'appearance' ? <section className="settings-section">
        <div className="settings-group-heading"><strong>{t('appearanceSurfaceGroup')}</strong><span>{t('appearanceSurfaceGroupDescription')}</span></div>
        <SettingRow label={t('theme')} description={t('themeDescription')}>{({ labelId, descriptionId }) => <Select value={settings.theme} onValueChange={(value) => { if (isThemeMode(value)) onChange('theme', value) }}><SelectTrigger aria-labelledby={labelId} aria-describedby={descriptionId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="dark">{t('dark')}</SelectItem><SelectItem value="light">{t('light')}</SelectItem><SelectItem value="system">{t('system')}</SelectItem></SelectContent></Select>}</SettingRow>
        <SettingRow label={t('density')} description={t('densityDescription')}>{({ labelId, descriptionId }) => <Select value={settings.density} onValueChange={(value) => { if (isDensity(value)) onChange('density', value) }}><SelectTrigger aria-labelledby={labelId} aria-describedby={descriptionId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="compact">{t('compact')}</SelectItem><SelectItem value="comfortable">{t('comfortable')}</SelectItem><SelectItem value="spacious">{t('spacious')}</SelectItem></SelectContent></Select>}</SettingRow>
        <div className="settings-group-heading"><strong>{t('typeScaleGroup')}</strong><span>{t('typeScaleGroupDescription')}</span></div>
        <SettingRow label={t('globalFontSize')} description={t('globalFontSizeDescription')} value={`${Math.round(settings.fontScale * 100)}%`}>{({ labelId, descriptionId }) => <Slider aria-labelledby={labelId} aria-describedby={descriptionId} aria-valuetext={`${Math.round(settings.fontScale * 100)}%`} min="0.9" max="1.2" step="0.05" value={settings.fontScale} onChange={(e) => onChange('fontScale', Number(e.target.value))} />}</SettingRow>
        <SettingRow label={t('readerFontSize')} description={t('readerFontSizeDescription')} value={`${Math.round(settings.readerFontScale * 100)}%`}>{({ labelId, descriptionId }) => <Slider aria-labelledby={labelId} aria-describedby={descriptionId} aria-valuetext={`${Math.round(settings.readerFontScale * 100)}%`} min="0.9" max="1.3" step="0.05" value={settings.readerFontScale} onChange={(e) => onChange('readerFontScale', Number(e.target.value))} />}</SettingRow>
        <SettingRow label={t('dateFormat')} description={t('dateFormatDescription')}>{({ labelId, descriptionId }) => <Select value={settings.dateFormat} onValueChange={(value) => { if (isDateFormat(value)) onChange('dateFormat', value) }}><SelectTrigger aria-labelledby={labelId} aria-describedby={descriptionId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">{t('system')}</SelectItem><SelectItem value="short">{t('shortDate')}</SelectItem><SelectItem value="long">{t('longDate')}</SelectItem></SelectContent></Select>}</SettingRow>
        <div className="settings-preview" aria-label={t('livePreview')}>
          <div className="settings-preview-header"><div><strong>{t('livePreview')}</strong><span>{t('livePreviewDescription')}</span></div><span className="settings-preview-status">{t('updatesLive')}</span></div>
          <div className={`settings-preview-mail-list settings-preview-density-${settings.density}`} style={{ fontSize: `${settings.fontScale}em` }} aria-hidden="true">
            <div className="settings-preview-mail-row settings-preview-mail-row-primary"><span className="settings-preview-avatar" /><span className="settings-preview-mail-copy"><strong>{accounts[0]?.address ?? t('noConnectedAccounts')}</strong><span>{t('subject')}</span><small>{t('message')}</small></span><span className="settings-preview-dot" /></div>
            <div className="settings-preview-mail-row"><span className="settings-preview-avatar settings-preview-avatar-muted" /><span className="settings-preview-mail-copy"><i /><i className="short" /></span></div>
            <div className="settings-preview-mail-row"><span className="settings-preview-avatar settings-preview-avatar-muted" /><span className="settings-preview-mail-copy"><i /><i className="medium" /></span></div>
          </div>
        </div>
      </section> : null}
      {activeTab === 'language' ? <section className="settings-section">
        <div className="settings-group-heading"><strong>{t('languageGroup')}</strong><span>{t('languageGroupDescription')}</span></div>
        <SettingRow label={t('language')} description={t('languageDescription')}>{({ labelId, descriptionId }) => <Select value={settings.language} onValueChange={(value) => { if (isLanguage(value)) updateLanguage(value) }}><SelectTrigger aria-labelledby={labelId} aria-describedby={descriptionId}><SelectValue /></SelectTrigger><SelectContent>{localeOptions.map((locale) => <SelectItem key={locale.code} value={locale.code}>{t(locale.labelKey)}</SelectItem>)}</SelectContent></Select>}</SettingRow>
        <div className="settings-group-heading"><strong>{t('regionalFormatGroup')}</strong><span>{t('regionalFormatGroupDescription')}</span></div>
        <SettingRow label={t('clockFormat')} description={t('clockFormatDescription')}>{({ labelId, descriptionId }) => <Select value={settings.clockFormat} onValueChange={(value) => { if (isClockFormat(value)) onChange('clockFormat', value) }}><SelectTrigger aria-labelledby={labelId} aria-describedby={descriptionId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="12">{t('clockFormat12Example')}</SelectItem><SelectItem value="24">{t('clockFormat24Example')}</SelectItem></SelectContent></Select>}</SettingRow>
      </section> : null}
      {activeTab === 'notifications' ? <section className="settings-section">
        <div className="settings-group-heading"><strong>{t('notificationDeliveryGroup')}</strong><span>{t('notificationDeliveryGroupDescription')}</span></div>
        <SettingRow label={t('notificationsEnabled')} description={t('notificationsEnabledDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.notificationsEnabled} onChange={(e) => onChange('notificationsEnabled', e.target.checked)} />}</SettingRow>
        <div className={`notification-permission-status ${notificationPermission}`} role="status"><span>{notificationPermissionLabel}</span>{notificationPermission !== 'granted' && notificationPermission !== 'requesting' ? <Button type="button" variant="ghost" size="default" disabled={!settings.notificationsEnabled} onClick={() => { void onRequestNotificationPermission() }}>{t('allowNotifications')}</Button> : null}</div>
        <SettingRow label={t('notificationSound')} description={t('notificationSoundDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.notificationSound} disabled={!settings.notificationsEnabled} onChange={(e) => onChange('notificationSound', e.target.checked)} />}</SettingRow>
        <SettingRow label={t('notificationSoundName')} description={t('notificationSoundNameDescription')}>{({ labelId, descriptionId }) => <Select value={settings.notificationSoundName} disabled={!settings.notificationsEnabled || !settings.notificationSound} onValueChange={(value) => { if (isNotificationSoundName(value)) onChange('notificationSoundName', value) }}><SelectTrigger aria-labelledby={labelId} aria-describedby={descriptionId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">{t('defaultSound')}</SelectItem><SelectItem value="soft">{t('softSound')}</SelectItem><SelectItem value="none">{t('noSound')}</SelectItem></SelectContent></Select>}</SettingRow>
        <div className="settings-group-heading"><strong>{t('quietHoursGroup')}</strong><span>{t('quietHoursGroupDescription')}</span></div>
        <SettingRow label={t('quietHours')} description={t('quietHoursDescription')}>{({ labelId, descriptionId }) => <Switch className="setting-toggle" aria-labelledby={labelId} aria-describedby={descriptionId} checked={settings.quietHoursEnabled} onChange={(e) => onChange('quietHoursEnabled', e.target.checked)} />}</SettingRow>
        {settings.quietHoursEnabled ? <div className="time-range"><label>{t('quietHoursStart')}<Input type="time" value={settings.quietHoursStart} onChange={(e) => onChange('quietHoursStart', e.target.value)} /></label><label>{t('quietHoursEnd')}<Input type="time" value={settings.quietHoursEnd} onChange={(e) => onChange('quietHoursEnd', e.target.value)} /></label></div> : null}
      </section> : null}
      {activeTab === 'oauth' ? <section className="settings-section oauth-settings-section">
        <div className="settings-group-heading"><strong>{t('oauthCredentialsGroup')}</strong><span>{t('oauthCredentialsGroupDescription')}</span></div>
        <div className="oauth-security-note" role="note"><IconKey aria-hidden="true" size={18} stroke={1.8} /><span>{t('oauthCredentialsStorageNote')}</span></div>
        <div className="oauth-provider-settings">
          <article className="oauth-provider-settings-card">
            <header><span className="oauth-provider-settings-identity"><span className="account-settings-logo"><img src={providerLogos.gmail} alt="" /></span><span><strong>{t('gmail')}</strong><small>{t('gmailOAuthCredentialsDescription')}</small></span></span><span className={`oauth-credential-status ${oauthCredentialStatus?.gmail.client_id && oauthCredentialStatus.gmail.client_secret ? 'configured' : 'missing'}`}>{oauthStatusError ? t('oauthCredentialsUnavailable') : oauthCredentialStatus?.gmail.client_id && oauthCredentialStatus.gmail.client_secret ? t('oauthCredentialsConfigured') : t('oauthCredentialsMissing')}</span></header>
            <div className="oauth-credential-fields">
              <label>{t('oauthClientId')}<Input value={gmailClientId} onChange={(event) => setGmailClientId(event.target.value)} autoComplete="off" placeholder={t('oauthClientIdPlaceholder')} /></label>
              <label>{t('oauthClientSecret')}<Input type="password" value={gmailClientSecret} onChange={(event) => setGmailClientSecret(event.target.value)} autoComplete="new-password" placeholder={t('oauthClientSecretPlaceholder')} /></label>
            </div>
            <footer><span>{t('oauthSecretNotShown')}</span><div><Button variant="ghost" disabled={!isOAuthProviderConfigured('gmail') || savingOAuthProvider !== null} onClick={() => { void handleClearOAuthCredentials('gmail') }}>{t('removeSavedCredentials')}</Button><Button disabled={savingOAuthProvider !== null} onClick={() => { void handleSaveOAuthCredentials('gmail') }}>{savingOAuthProvider === 'gmail' ? t('saving') : t('saveCredentials')}</Button></div></footer>
          </article>
          <article className="oauth-provider-settings-card">
            <header><span className="oauth-provider-settings-identity"><span className="account-settings-logo"><img src={providerLogos.outlook} alt="" /></span><span><strong>{t('outlook')}</strong><small>{t('outlookOAuthCredentialsDescription')}</small></span></span><span className={`oauth-credential-status ${oauthCredentialStatus?.outlook.client_id ? 'configured' : 'missing'}`}>{oauthStatusError ? t('oauthCredentialsUnavailable') : oauthCredentialStatus?.outlook.client_id ? t('oauthCredentialsConfigured') : t('oauthCredentialsMissing')}</span></header>
            <div className="oauth-credential-fields single">
              <label>{t('oauthClientId')}<Input value={outlookClientId} onChange={(event) => setOutlookClientId(event.target.value)} autoComplete="off" placeholder={t('oauthClientIdPlaceholder')} /></label>
            </div>
            <footer><span>{t('outlookPublicClientNote')}</span><div><Button variant="ghost" disabled={!isOAuthProviderConfigured('outlook') || savingOAuthProvider !== null} onClick={() => { void handleClearOAuthCredentials('outlook') }}>{t('removeSavedCredentials')}</Button><Button disabled={savingOAuthProvider !== null} onClick={() => { void handleSaveOAuthCredentials('outlook') }}>{savingOAuthProvider === 'outlook' ? t('saving') : t('saveCredentials')}</Button></div></footer>
          </article>
        </div>
        {oauthNotice ? <div className="oauth-credential-notice" role="status">{oauthNotice}</div> : null}
      </section> : null}
      {activeTab === 'accounts' ? <section className="settings-section accounts-section">
        <div className="settings-group-heading settings-accounts-heading"><div><strong>{t('connectedAccountsGroup')}</strong><span>{t('connectedAccountsGroupDescription')}</span></div><output>{t('connectedAccountsCount', { count: accounts.length })}</output></div>
        <div className="account-settings-list">
          {accounts.length > 0 ? accounts.map((account) => (
            <article className="account-settings-row" key={account.id}>
              <div className="account-settings-identity">
                <span className="account-settings-logo"><img src={providerLogos[account.provider]} alt="" /></span>
                <div><strong dir="ltr">{account.address}</strong><span>{t(account.provider)} · {t('accountConnected')}</span></div>
              </div>
              <div className="account-settings-meta">
                {account.id === defaultAccountId ? <span className="account-default-badge">{t('defaultAccount')}</span> : null}
                <div className="account-settings-actions">
                  {account.id !== defaultAccountId ? <Button className="account-default-action" variant="ghost" disabled={isAuthInFlight} onClick={() => onSetDefault(account.id)}>{t('setDefault')}</Button> : null}
                  <Button className="account-settings-action" variant="ghost" size="icon" disabled={isAuthInFlight} aria-label={t('reconnectAccount')} title={t('reconnectAccount')} onClick={() => { void reconnectAccount(account) }}><IconRefresh aria-hidden="true" size={16} stroke={1.8} /></Button>
                  <Button className="account-settings-action account-settings-remove-action" variant="ghost" size="icon" disabled={isAuthInFlight} aria-label={t('removeAccount')} title={t('removeAccount')} onClick={() => setAccountToRemoveId(account.id)}><IconTrash aria-hidden="true" size={16} stroke={1.8} /></Button>
                </div>
              </div>
            </article>
          )) : <div className="accounts-empty-state"><IconMailPlus size={22} stroke={1.8} aria-hidden="true" /><strong>{t('noConnectedAccounts')}</strong><span>{t('noConnectedAccountsDescription')}</span></div>}
        </div>
      </section> : null}
      </div>
    </div>
    <Dialog open={isAddAccountOpen} title={t('addAccount')} closeLabel={t('closeDialog')} returnFocusRef={addAccountButtonRef} initialFocusRef={firstProviderButtonRef} onClose={() => onAddAccountOpenChange(false)}>
      {oauthCredentialStatus && (!isOAuthProviderConfigured('gmail') || !isOAuthProviderConfigured('outlook')) ? <div className="oauth-dialog-notice"><span>{t('oauthCredentialsRequiredForAccount')}</span><Button variant="ghost" onClick={() => { onAddAccountOpenChange(false); setActiveTab('oauth') }}>{t('openOAuthSettings')}</Button></div> : null}
      <div className="provider-action-cards" role="group" aria-label={t('accountProviderTabs')}>
        {(['gmail', 'outlook'] as const).map((provider, index) => (
          <button
            key={provider}
            ref={index === 0 ? firstProviderButtonRef : undefined}
            className="provider-action-card"
            type="button"
            disabled={isAddingAccount || !isOAuthProviderConfigured(provider)}
            aria-busy={isAddingAccount && addingProvider === provider}
            onClick={() => { void handleStartAuth(provider) }}
          >
            <span className="provider-action-logo" aria-hidden="true">
              <img src={providerLogos[provider]} alt="" />
            </span>
            <span className="provider-action-content">
              <strong>{t(provider)}</strong>
              <span>{isOAuthProviderConfigured(provider) ? t(provider === 'gmail' ? 'continueWithGmail' : 'continueWithOutlook') : t('configureOAuthCredentials')}</span>
            </span>
            {isAddingAccount && addingProvider === provider ? (
              <span className="provider-action-status">{t('connecting')}</span>
            ) : null}
            <IconChevronRight className="provider-action-arrow" aria-hidden="true" size={18} stroke={1.8} />
          </button>
        ))}
      </div>
    </Dialog>
    <Dialog open={accountToRemoveId !== null} title={t('removeAccount')} closeLabel={t('closeDialog')} onClose={() => setAccountToRemoveId(null)}>
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
