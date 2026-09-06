import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './App.css'

type MailboxFilter = 'all' | 'gmail' | 'outlook'

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
          <span className="brand-dot" aria-hidden="true" />
          <span>OpenMail</span>
        </div>
      </div>
      <div className="window-controls" data-tauri-drag-region="false">
        <button className="window-control" type="button" aria-label={t('minimize')} onClick={() => void minimize()}>
          <span aria-hidden="true">−</span>
        </button>
        <button className="window-control" type="button" aria-label={t(isMaximized ? 'restore' : 'maximize')} onClick={() => void toggleMaximize()}>
          <span aria-hidden="true">{isMaximized ? '❐' : '□'}</span>
        </button>
        <button className="window-control close-control" type="button" aria-label={t('close')} onClick={() => void close()}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </header>
  )
}

function App() {
  const { t, i18n } = useTranslation()
  const [mailboxFilter, setMailboxFilter] = useState<MailboxFilter>('all')
  const [isComposerOpen, setIsComposerOpen] = useState(false)

  return (
    <main className="app-shell">
      <WindowHeader />
      <aside className="sidebar" aria-label={t('navigation')}>
        <div className="brand-mark"><span className="brand-dot" aria-hidden="true" /><span>OpenMail</span></div>
        <button className="compose-button" type="button" onClick={() => setIsComposerOpen(true)}><span aria-hidden="true">+</span>{t('compose')}</button>
        <nav className="mail-nav" aria-label="Posta klasörleri">
          <button className="nav-item active" type="button"><span aria-hidden="true">□</span>{t('inbox')}<span className="nav-count">0</span></button>
          <button className="nav-item" type="button"><span aria-hidden="true">☆</span>{t('starred')}</button>
          <button className="nav-item" type="button"><span aria-hidden="true">↗</span>{t('sent')}</button>
          <button className="nav-item" type="button"><span aria-hidden="true">⌁</span>{t('archive')}</button>
          <button className="nav-item" type="button"><span aria-hidden="true">⌫</span>{t('trash')}</button>
        </nav>
        <div className="sidebar-footer">
          <button className="nav-item" type="button"><span aria-hidden="true">⚙</span>{t('settings')}</button>
          <button className="language-button" type="button" onClick={() => void i18n.changeLanguage(i18n.language === 'en' ? 'tr' : 'en')}>
            {t('language')}: {i18n.language === 'en' ? 'English' : 'Türkçe'}
          </button>
          <div className="sync-state"><span className="status-dot" aria-hidden="true" />{t('syncReady')}</div>
        </div>
      </aside>
      <section className="content-area">
        <header className="topbar">
          <div><p className="eyebrow">{t('mailbox')}</p><h1>{t('inbox')}</h1></div>
          <div className="topbar-actions">
            <label className="search-box"><span aria-hidden="true">⌕</span><input type="search" placeholder={t('search')} aria-label={t('search')} /></label>
            <button className="icon-button" type="button" aria-label={t('sync')}>↻</button>
            <button className="profile-button" type="button" aria-label={t('accountMenu')}>A</button>
          </div>
        </header>
        <div className="mailbox-toolbar">
          <div className="filter-tabs" role="tablist" aria-label="Hesap filtresi">
            <button className={mailboxFilter === 'all' ? 'filter-tab selected' : 'filter-tab'} type="button" onClick={() => setMailboxFilter('all')}>{t('all')}</button>
            <button className={mailboxFilter === 'gmail' ? 'filter-tab selected' : 'filter-tab'} type="button" onClick={() => setMailboxFilter('gmail')}>{t('gmail')}</button>
            <button className={mailboxFilter === 'outlook' ? 'filter-tab selected' : 'filter-tab'} type="button" onClick={() => setMailboxFilter('outlook')}>{t('outlook')}</button>
          </div>
          <span className="mail-count">{t('mailCount', { count: 0 })}</span>
        </div>
        <section className="empty-state" aria-live="polite">
          <div className="empty-icon" aria-hidden="true">⌁</div><h2>{t('emptyTitle')}</h2>
          <p>{t('emptyDescription')}</p><button className="connect-button" type="button">{t('connectAccount')}</button>
        </section>
      </section>
      {isComposerOpen && <div className="modal-backdrop"><section className="composer-modal" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <div className="modal-heading"><div><p className="eyebrow">{t('newMessage')}</p><h2 id="composer-title">{t('composeMail')}</h2></div><button className="icon-button" type="button" aria-label={t('close')} onClick={() => setIsComposerOpen(false)}>×</button></div>
        <label className="field-label">{t('recipient')}<input type="email" placeholder={t('recipientPlaceholder')} /></label>
        <label className="field-label">{t('subject')}<input type="text" placeholder={t('subjectPlaceholder')} /></label>
        <label className="field-label">{t('message')}<textarea placeholder={t('messagePlaceholder')} rows={7} /></label>
        <div className="composer-actions"><button className="secondary-button" type="button" onClick={() => setIsComposerOpen(false)}>{t('cancel')}</button><button className="connect-button" type="button">{t('send')}</button></div>
      </section></div>}
    </main>
  )
}

export default App
