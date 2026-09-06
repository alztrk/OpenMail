import { type MouseEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconMaximize, IconMinus, IconSearch, IconSettings, IconStar, IconX, IconRestore } from '@tabler/icons-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import openMailWordmark from './assets/openmail-wordmark.svg'
import gmailLogo from './assets/providers/gmail.svg'
import outlookLogo from './assets/providers/outlook.svg'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/mail/empty-state'
import { MailContextMenu } from '@/components/mail/mail-context-menu'
import { MailRow } from '@/components/mail/mail-row'
import { ReaderToolbar } from '@/components/mail/reader-toolbar'
import { Badge } from '@/components/ui/badge'
import { SettingsPanel } from '@/components/settings/settings-panel'
import { loadSettings, saveSettings, type AppSettings } from '@/settings'
import './App.css'

type MailAccount = {
  id: string
  address: string
  provider: 'gmail' | 'outlook'
}

type MailMessage = {
  id: string
  sender: string
  address: string
  subject: string
  preview: string
  body: string
  time: string
  unread: boolean
  starred: boolean
  hasAttachment: boolean
}

const connectedAccounts: MailAccount[] = [
  { id: 'mock-gmail-personal', address: 'personal@gmail.com', provider: 'gmail' },
  { id: 'mock-outlook-work', address: 'work@outlook.com', provider: 'outlook' },
  { id: 'mock-gmail-projects', address: 'projects@gmail.com', provider: 'gmail' },
]

const providerLogos = {
  gmail: gmailLogo,
  outlook: outlookLogo,
} as const

const mockMessages: MailMessage[] = [
  {
    id: 'mock-message-1',
    sender: 'OpenMail Team',
    address: 'team@openmail.app',
    subject: 'Your workspace is ready',
    preview: 'Everything is set up. You can now manage your accounts from one place.',
    body: 'Everything is set up. You can now manage your accounts from one place. We will keep this workspace fast, local, and easy to scan as you add more mail accounts.',
    time: '10:42',
    unread: true,
    starred: true,
    hasAttachment: false,
  },
  {
    id: 'mock-message-2',
    sender: 'Mert Kaya',
    address: 'mert@example.com',
    subject: 'Project notes for this week',
    preview: 'I added the latest notes and the decisions from our last review.',
    body: 'I added the latest notes and the decisions from our last review. Let me know if you want me to expand the section about the next release.',
    time: '09:18',
    unread: true,
    starred: false,
    hasAttachment: true,
  },
  {
    id: 'mock-message-3',
    sender: 'Google Calendar',
    address: 'calendar@google.com',
    subject: 'Reminder: Design review',
    preview: 'Tomorrow at 14:00. The meeting link is included in the invitation.',
    body: 'This is a reminder for your design review tomorrow at 14:00. The meeting link is included in the invitation.',
    time: '09/05',
    unread: false,
    starred: false,
    hasAttachment: false,
  },
  {
    id: 'mock-message-4',
    sender: 'Ayşe Demir',
    address: 'ayse@example.com',
    subject: 'Brand assets',
    preview: 'The updated logo variants are attached for your review.',
    body: 'The updated logo variants are attached for your review. I kept the wordmark spacing consistent across the light and dark versions.',
    time: '08/28',
    unread: false,
    starred: true,
    hasAttachment: true,
  },
]

function WindowHeader() {
  const { t } = useTranslation()
  const [isMaximized, setIsMaximized] = useState(false)

  const minimize = async () => {
    await getCurrentWindow().minimize()
  }

  const toggleMaximize = async () => {
    const window = getCurrentWindow()
    await window.toggleMaximize()
    setIsMaximized(await window.isMaximized())
  }

  const close = async () => {
    await getCurrentWindow().close()
  }

  return (
    <header className="window-header">
      <div className="window-drag-region" data-tauri-drag-region="true">
        <div className="window-brand">
          <img className="window-brand-logo" src={openMailWordmark} alt={t('openMailLogoAlt')} />
        </div>
      </div>
      <div className="window-controls" data-tauri-drag-region="false">
        <button className="window-control" type="button" aria-label={t('minimize')} onClick={() => void minimize()}>
          <IconMinus aria-hidden="true" size={16} stroke={1.8} />
        </button>
        <button className="window-control" type="button" aria-label={t(isMaximized ? 'restore' : 'maximize')} onClick={() => void toggleMaximize()}>
          {isMaximized ? <IconRestore aria-hidden="true" size={15} stroke={1.8} /> : <IconMaximize aria-hidden="true" size={15} stroke={1.8} />}
        </button>
        <button className="window-control close-control" type="button" aria-label={t('close')} onClick={() => void close()}>
          <IconX aria-hidden="true" size={16} stroke={1.8} />
        </button>
      </div>
    </header>
  )
}

function App() {
  const { t } = useTranslation()
  const [activeAccountId, setActiveAccountId] = useState(connectedAccounts[0].id)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<'all' | 'unread' | 'starred' | 'attachments'>('all')
  const [activeView, setActiveView] = useState<'mail' | 'settings'>('mail')
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number } | null>(null)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : settings.theme === 'system' ? 'dark' : settings.theme
    document.documentElement.style.setProperty('--app-font-scale', String(settings.fontScale))
    document.documentElement.style.setProperty('--reader-font-scale', String(settings.readerFontScale))
    document.documentElement.style.setProperty('--mail-sidebar-width', `${settings.sidebarWidth}px`)
    document.documentElement.style.setProperty('--reader-content-width', `${settings.readerWidth}px`)
    document.documentElement.dataset.density = settings.density
  }, [settings])

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const activeAccount = connectedAccounts.find((account) => account.id === activeAccountId) ?? connectedAccounts[0]
  const selectedMessage = mockMessages.find((message) => message.id === selectedMessageId) ?? null
  const filteredMessages = mockMessages.filter((message) => {
    const matchesSearch = normalizedQuery.length === 0 || [message.sender, message.subject, message.preview].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    const matchesFilter = activeFilter === 'all' || (activeFilter === 'unread' && message.unread) || (activeFilter === 'starred' && message.starred) || (activeFilter === 'attachments' && message.hasAttachment)
    return matchesSearch && matchesFilter
  })

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('[data-context-menu="mail"]')) {
      event.preventDefault()
    }
  }

  const handleMailContextMenu = (messageId: string, x: number, y: number) => {
    setContextMenu({ messageId, x, y })
  }

  const updateSetting = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => {
    setSettings((current) => {
      const next = { ...current, [key]: value }
      saveSettings(next)
      return next
    })
  }

  return (
    <main className="app-shell" onContextMenu={handleContextMenu} onClick={() => setContextMenu(null)}>
      <WindowHeader />
      <aside className="sidebar" aria-label={t('navigation')}>
          <nav className="account-list" aria-label={t('accounts')}>
            {connectedAccounts.map((account) => (
              <button className={`account-button ${activeAccountId === account.id ? 'active' : ''}`} key={account.id} type="button" aria-label={account.address} aria-pressed={activeAccountId === account.id} onClick={() => { setActiveAccountId(account.id); setActiveView('mail') }}>
                <span className="account-avatar" aria-hidden="true">
                  <img src={providerLogos[account.provider]} alt="" />
                </span>
                <span className="account-popover" role="tooltip">
                  <strong>{t(account.provider)}</strong>
                  <span>{account.address}</span>
                </span>
              </button>
            ))}
        </nav>
        <div className="sidebar-footer">
          <button className={`settings-button ${activeView === 'settings' ? 'active' : ''}`} type="button" aria-label={t('settings')} aria-pressed={activeView === 'settings'} onClick={() => { setActiveView('settings'); setContextMenu(null) }}>
            <IconSettings aria-hidden="true" size={18} stroke={1.8} />
          </button>
        </div>
      </aside>
      <section className={`content-area ${activeView === 'settings' ? 'settings-active' : ''}`}>
        <aside className="main-sidebar" aria-label={t('mainSidebar')}>
          <div className="mail-sidebar-header">
            <h1>{t('inbox')}</h1>
          </div>
            <label className="mail-search">
              <IconSearch className="search-mark" aria-hidden="true" size={17} stroke={1.8} />
              <Input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t('searchMail')} aria-label={t('searchMail')} />
            </label>
          <Button className="spam-button" variant="ghost" disabled>
            <span>{t('spam')}</span>
            <Badge>1</Badge>
          </Button>
          <div className="mail-filters" aria-label={t('filterMail')}>
            {(['all', 'unread', 'starred', 'attachments'] as const).map((filter) => (
              <button className={`mail-filter ${activeFilter === filter ? 'active' : ''}`} key={filter} type="button" onClick={() => setActiveFilter(filter)}>
                {t(`${filter}Mail`)}
              </button>
            ))}
          </div>
          <div className="message-list">
            {filteredMessages.length > 0 ? filteredMessages.map((message) => (
              <MailRow key={message.id} message={message} selected={selectedMessageId === message.id} unreadLabel={t('unreadMail')} onSelect={(messageId) => { setSelectedMessageId(messageId); setContextMenu(null) }} onContextMenu={handleMailContextMenu} />
            )) : (
              <div className="message-list-empty">
                <strong>{t('noMailResults')}</strong>
                <span>{t('noMailResultsDescription')}</span>
              </div>
            )}
          </div>
        </aside>
        <section className="main-canvas" aria-label={t('mainCanvas')}>
          {selectedMessage ? (
            <article className="mail-reader">
              <ReaderToolbar labels={{ archive: t('archive'), delete: t('delete'), markUnread: t('markUnread'), reply: t('reply'), moreActions: t('moreActions'), backToMailList: t('backToMailList') }} onBack={() => setSelectedMessageId(null)} />
              <header className="reader-header">
                <div className="reader-title-row">
                  <h2>{selectedMessage.subject}</h2>
                  <Button className="reader-star" variant="ghost" size="icon" type="button" aria-label={t('starredMail')} disabled>
                    <IconStar aria-hidden="true" size={18} stroke={1.8} />
                  </Button>
                </div>
                <div className="reader-meta">
                  <span className="reader-avatar" aria-hidden="true">{selectedMessage.sender.slice(0, 1)}</span>
                  <div>
                    <strong>{selectedMessage.sender}</strong>
                    <span><small>{t('from')}</small>{selectedMessage.address}</span>
                    <span><small>{t('to')}</small>{activeAccount.address}</span>
                  </div>
                  <time>{selectedMessage.time}</time>
                </div>
              </header>
              <div className="reader-body">
                <p>{selectedMessage.body}</p>
              </div>
            </article>
          ) : (
            <EmptyState title={t('noMailSelected')} description={t('noMailSelectedDescription')} />
          )}
        </section>
        {activeView === 'settings' ? <section className="settings-page" aria-labelledby="settings-title"><SettingsPanel settings={settings} onChange={updateSetting} /></section> : null}
      </section>
      {contextMenu ? <MailContextMenu x={contextMenu.x} y={contextMenu.y} labels={{ markUnread: t('markUnread'), star: t('starMail'), archive: t('archive'), delete: t('delete') }} onClose={() => setContextMenu(null)} /> : null}
    </main>
  )
}

export default App
