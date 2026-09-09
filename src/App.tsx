import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject, type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { IconAlertTriangle, IconChevronDown, IconDownload, IconInbox, IconMaximize, IconMinus, IconPaperclip, IconPencil, IconRefresh, IconSearch, IconSend, IconSettings, IconStar, IconTrash, IconX, IconRestore } from '@tabler/icons-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import openMailWordmark from './assets/openmail-wordmark.svg'
import gmailLogo from './assets/providers/gmail.svg'
import outlookLogo from './assets/providers/outlook.svg'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/mail/empty-state'
import { MailContextMenu } from '@/components/mail/mail-context-menu'
import { MailHtml } from '@/components/mail/mail-html'
import { MailRow } from '@/components/mail/mail-row'
import { MailListEmptyState } from '@/components/mail/mail-list-empty-state'
import { MailSearchDialog, type MailSearchResult } from '@/components/mail/mail-search-dialog'
import { SenderAvatar } from '@/components/mail/sender-avatar'
import { ReaderToolbar } from '@/components/mail/reader-toolbar'
import { ReplyComposer } from '@/components/mail/reply-composer'
import { ThreadMessageCard } from '@/components/mail/thread-message-card'
import { ComposeForm } from '@/components/mail/compose-form'
import { Toast } from '@/components/ui/toast'
import { Dialog } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsPanel } from '@/components/settings/settings-panel'
import { areValidEmailAddresses, splitEmailAddresses } from '@/lib/utils'
import { getSenderLabel } from '@/lib/mail'
import { loadSettings, saveSettings, type AppSettings } from '@/settings'
import './App.css'

type MailAccount = {
  id: string
  address: string
  provider: 'gmail' | 'outlook'
  is_default: boolean
}

type AuthState = {
  status: 'idle' | 'waiting_for_callback' | 'connected' | 'failed'
  account_id: string | null
  error: string | null
}

type ProviderCapabilities = {
  can_search: boolean
  can_send: boolean
  can_reply: boolean
  can_archive: boolean
  can_delete: boolean
  can_permanently_delete: boolean
  can_mark_read: boolean
  can_star: boolean
  can_spam: boolean
  supports_incremental_sync: boolean
  supports_html: boolean
  supports_attachments: boolean
}

type MessageAction = 'archive' | 'trash' | 'untrash' | 'spam' | 'not_spam' | 'delete_forever' | 'mark_read' | 'mark_unread' | 'star' | 'unstar'

type MailFolder = 'inbox' | 'spam' | 'sent' | 'trash' | 'starred'
type MailFilter = 'all' | 'unread' | 'starred' | 'attachments'

type MailMessage = {
  id: string
  thread_id?: string | null
  message_id_header?: string | null
  sender: string
  address: string
  subject: string
  preview: string
  body: string
  body_html?: string | null
  avatar_url?: string | null
  time: string
  unread: boolean
  starred: boolean
  hasAttachment: boolean
  attachments?: MailAttachment[]
}

type MailAttachment = {
  id: string
  filename: string
  mime_type: string
  size: number
}

type MessagePage = {
  messages: MailMessage[]
  next_page_token: string | null
  history_id?: string | null
}

type SyncResult = {
  page: MessagePage
  new_message_count: number
}

type AccountSyncStatus = 'idle' | 'syncing' | 'error'

type ComposeDraft = {
  recipient: string
  cc?: string
  bcc?: string
  subject: string
  body: string
}

function isComposeDraft(value: unknown): value is ComposeDraft {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Record<string, unknown>
  return typeof draft.recipient === 'string'
    && typeof draft.subject === 'string'
    && typeof draft.body === 'string'
}

function isQuietHours(settings: AppSettings): boolean {
  if (!settings.quietHoursEnabled) return false
  const currentMinutes = new Date().getHours() * 60 + new Date().getMinutes()
  const [startHour, startMinute] = settings.quietHoursStart.split(':').map(Number)
  const [endHour, endMinute] = settings.quietHoursEnd.split(':').map(Number)
  const startMinutes = startHour * 60 + startMinute
  const endMinutes = endHour * 60 + endMinute
  return startMinutes <= endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes
}

function getNotificationSound(settings: AppSettings): string | undefined {
  if (!settings.notificationSound || settings.notificationSoundName === 'none') return undefined
  if (settings.notificationSoundName === 'soft') return 'C:\\Windows\\Media\\Windows Notify Messaging.wav'
  return 'C:\\Windows\\Media\\Windows Notify Email.wav'
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatMessageTime(value: string, settings: AppSettings, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const dateStyle = settings.dateFormat === 'short' ? 'short' : settings.dateFormat === 'long' ? 'long' : undefined
  return new Intl.DateTimeFormat(locale, {
    dateStyle,
    timeStyle: 'short',
    hour12: settings.clockFormat === '12',
  }).format(date)
}

function mergeMessageDetails(existing: MailMessage, incoming: MailMessage): MailMessage {
  return {
    ...incoming,
    body: incoming.body || existing.body,
    body_html: incoming.body_html ?? existing.body_html,
    avatar_url: incoming.avatar_url ?? existing.avatar_url,
    attachments: incoming.attachments?.length ? incoming.attachments : existing.attachments,
    hasAttachment: incoming.hasAttachment || existing.hasAttachment,
  }
}

function mergeMessageLists(existing: MailMessage[], incoming: MailMessage[]): MailMessage[] {
  const existingById = new Map(existing.map((message) => [message.id, message]))
  return incoming.map((message) => {
    const previousMessage = existingById.get(message.id)
    return previousMessage ? mergeMessageDetails(previousMessage, message) : message
  })
}

function appendUniqueMessages(existing: MailMessage[], incoming: MailMessage[]): MailMessage[] {
  const result = [...existing]
  const indexes = new Map(result.map((message, index) => [message.id, index]))
  incoming.forEach((message) => {
    const existingIndex = indexes.get(message.id)
    if (existingIndex === undefined) {
      indexes.set(message.id, result.length)
      result.push(message)
      return
    }
    result[existingIndex] = mergeMessageDetails(result[existingIndex], message)
  })
  return result
}

function mergeSearchResults(existing: MailSearchResult[], incoming: MailSearchResult[]): MailSearchResult[] {
  const result = [...existing]
  const indexes = new Map(result.map((item, index) => [`${item.account.id}:${item.message.id}`, index]))
  incoming.forEach((item) => {
    const key = `${item.account.id}:${item.message.id}`
    const existingIndex = indexes.get(key)
    if (existingIndex === undefined) {
      indexes.set(key, result.length)
      result.push(item)
      return
    }
    result[existingIndex] = {
      account: item.account,
      message: { ...result[existingIndex].message, ...item.message },
    }
  })
  return result.sort((left, right) => {
    const leftTime = new Date(left.message.time).getTime()
    const rightTime = new Date(right.message.time).getTime()
    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return 0
    return rightTime - leftTime
  })
}

const providerLogos = {
  gmail: gmailLogo,
  outlook: outlookLogo,
} as const

const foregroundSyncIntervalMs = 30000
const backgroundSyncIntervalMs = 120000

type WindowHeaderProps = {
  onRequestClose: () => void
  minimizeToTray: boolean
  searchQuery: string
  searchDisabled: boolean
  searchLabel: string
  searchCompactLabel: string
  searchOpen: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  onSearchQueryChange: (value: string) => void
  onSearchFocus: () => void
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  onClearSearch: () => void
  children?: ReactNode
}

function WindowHeader({ onRequestClose, minimizeToTray, searchQuery, searchDisabled, searchLabel, searchCompactLabel, searchOpen, searchInputRef, onSearchQueryChange, onSearchFocus, onSearchKeyDown, onClearSearch, children }: WindowHeaderProps) {
  const { t } = useTranslation()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isTauriRuntime()) return undefined
    let cancelled = false
    void getCurrentWindow().isMaximized().then((maximized) => {
      if (!cancelled) setIsMaximized(maximized)
    }).catch(() => {
      if (!cancelled) setIsMaximized(false)
    })
    return () => { cancelled = true }
  }, [])

  const minimize = async () => {
    if (!isTauriRuntime()) return
    const window = getCurrentWindow()
    if (minimizeToTray) {
      await window.hide()
      return
    }
    await window.minimize()
  }

  const toggleMaximize = async () => {
    if (!isTauriRuntime()) return
    const window = getCurrentWindow()
    await window.toggleMaximize()
    setIsMaximized(await window.isMaximized())
  }

  return (
    <header className="window-header">
      <div className="window-drag-region" data-tauri-drag-region="true" onDoubleClick={() => { void toggleMaximize() }}>
        <div className="window-brand">
          <img className="window-brand-logo" src={openMailWordmark} alt={t('openMailLogoAlt')} />
        </div>
        <div className="window-search-surface" data-search-surface data-tauri-drag-region="false" onDoubleClick={(event) => event.stopPropagation()}>
          <label className={`window-search ${searchDisabled ? 'disabled' : ''}`} data-compact-label={searchCompactLabel} data-has-value={searchQuery.length > 0 ? 'true' : 'false'}>
            <IconSearch className="window-search-mark" aria-hidden="true" size={16} stroke={1.8} />
            <Input ref={searchInputRef} type="search" value={searchQuery} disabled={searchDisabled} title={searchLabel} onFocus={onSearchFocus} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={onSearchKeyDown} placeholder={searchLabel} aria-label={searchLabel} role="combobox" aria-autocomplete="list" aria-haspopup="dialog" aria-expanded={searchOpen} aria-controls={searchOpen ? 'search-results-dialog' : undefined} aria-keyshortcuts="Control+K Meta+K" autoComplete="off" />
            {searchQuery.length > 0 ? <button className="window-search-clear" type="button" aria-label={t('clearSearch')} title={t('clearSearch')} onClick={onClearSearch}><IconX aria-hidden="true" size={15} stroke={1.8} /></button> : null}
          </label>
          {children}
        </div>
      </div>
      <div className="window-controls" data-tauri-drag-region="false">
        <button className="window-control" type="button" aria-label={t('minimize')} title={t('minimize')} disabled={!isTauriRuntime()} onClick={() => void minimize()}>
          <IconMinus aria-hidden="true" size={16} stroke={1.8} />
        </button>
        <button className="window-control" type="button" aria-label={t(isMaximized ? 'restore' : 'maximize')} title={t(isMaximized ? 'restore' : 'maximize')} disabled={!isTauriRuntime()} onClick={() => void toggleMaximize()}>
          {isMaximized ? <IconRestore aria-hidden="true" size={15} stroke={1.8} /> : <IconMaximize aria-hidden="true" size={15} stroke={1.8} />}
        </button>
        <button className="window-control close-control" type="button" aria-label={t('close')} title={t('close')} disabled={!isTauriRuntime()} onClick={onRequestClose}>
          <IconX aria-hidden="true" size={16} stroke={1.8} />
        </button>
      </div>
    </header>
  )
}

type AccountButtonProps = {
  account: MailAccount
  active: boolean
  syncStatus: AccountSyncStatus
  providerLogos: typeof providerLogos
  tabIndex: 0 | -1
  onSelect: () => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
}

function AccountButton({ account, active, syncStatus, providerLogos, tabIndex, onSelect, onKeyDown }: AccountButtonProps) {
  const { t } = useTranslation()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLSpanElement>(null)
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null)

  const updatePopoverPosition = useCallback(() => {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      setPopoverPosition(null)
      return
    }
    setPopoverPosition({ left: Math.round(rect.right + 12), top: Math.round(rect.top + rect.height / 2) })
  }, [])

  const hidePopover = useCallback(() => setPopoverPosition(null), [])

  useLayoutEffect(() => {
    if (!popoverPosition) return
    const popover = popoverRef.current
    if (!popover) return
    const edgePadding = 8
    const halfHeight = popover.offsetHeight / 2
    const maxLeft = Math.max(edgePadding, window.innerWidth - popover.offsetWidth - edgePadding)
    const minTop = edgePadding + halfHeight
    const maxTop = Math.max(minTop, window.innerHeight - edgePadding - halfHeight)
    const nextPosition = {
      left: Math.round(Math.min(Math.max(popoverPosition.left, edgePadding), maxLeft)),
      top: Math.round(Math.min(Math.max(popoverPosition.top, minTop), maxTop)),
    }
    if (nextPosition.left === popoverPosition.left && nextPosition.top === popoverPosition.top) return
    setPopoverPosition(nextPosition)
  }, [popoverPosition])

  useEffect(() => {
    if (!popoverPosition) return undefined
    const handlePositionChange = () => updatePopoverPosition()
    window.addEventListener('resize', handlePositionChange)
    window.addEventListener('scroll', handlePositionChange, true)
    return () => {
      window.removeEventListener('resize', handlePositionChange)
      window.removeEventListener('scroll', handlePositionChange, true)
    }
  }, [popoverPosition, updatePopoverPosition])

  const syncLabel = syncStatus === 'syncing' ? 'accountSyncing' : syncStatus === 'error' ? 'accountSyncFailed' : 'accountSynced'
  const accountLabel = active
    ? `${t(account.provider)}, ${account.address}, ${t('activeAccount')}, ${t(syncLabel)}`
    : `${t(account.provider)}, ${account.address}, ${t(syncLabel)}`

  return <>
    <button ref={buttonRef} className={`account-button ${active ? 'active' : ''}`} data-account-id={account.id} type="button" tabIndex={tabIndex} aria-label={accountLabel} title={accountLabel} aria-current={active ? 'page' : undefined} onClick={() => { hidePopover(); onSelect() }} onKeyDown={onKeyDown} onMouseEnter={updatePopoverPosition} onMouseLeave={hidePopover} onFocus={updatePopoverPosition} onBlur={hidePopover}>
      <span className="account-avatar" aria-hidden="true">
        <img src={providerLogos[account.provider]} alt="" />
      </span>
      <span className={`account-sync-status ${syncStatus}`} aria-hidden="true" />
    </button>
    {popoverPosition ? createPortal(
      <span ref={popoverRef} className="account-popover account-popover-portal" role="tooltip" aria-hidden="true" style={{ left: `${popoverPosition.left}px`, top: `${popoverPosition.top}px` }}>
        <strong>{t(account.provider)}</strong>
        <span>{account.address}</span>
      </span>,
      document.body,
    ) : null}
  </>
}

function App() {
  const { t, i18n } = useTranslation()
  const getDisplayError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('AUTH_REQUIRED:')) return t('gmailReauthorizationRequired')
    if (message.startsWith('GMAIL_CLIENT_CONFIG:')) return t('gmailClientConfigurationRequired')
    if (message.startsWith('GMAIL_PERMISSION_REQUIRED:')) return t('gmailPermissionRequired')
    if (message === 'EMPTY_CONVERSATION') return t('emptyConversation')
    return message
  }, [t])
  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [accountSyncStatus, setAccountSyncStatus] = useState<Record<string, AccountSyncStatus>>({})
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(() => isTauriRuntime())
  const [accountLoadError, setAccountLoadError] = useState(false)
  const [activeAccountId, setActiveAccountId] = useState('')
  const accountListRef = useRef<HTMLElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [searchResults, setSearchResults] = useState<MailSearchResult[]>([])
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isSearchingMail, setIsSearchingMail] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [searchPartialError, setSearchPartialError] = useState(false)
  const [searchActiveIndex, setSearchActiveIndex] = useState(0)
  const [searchPageTokens, setSearchPageTokens] = useState<Record<string, string | null>>({})
  const [isLoadingMoreSearch, setIsLoadingMoreSearch] = useState(false)
  const [searchRetryNonce, setSearchRetryNonce] = useState(0)
  const [activeFolder, setActiveFolder] = useState<MailFolder>('inbox')
  const [folderMessages, setFolderMessages] = useState<MailMessage[]>([])
  const [folderNextPageToken, setFolderNextPageToken] = useState<string | null>(null)
  const [isLoadingFolder, setIsLoadingFolder] = useState(false)
  const [mailboxLoadError, setMailboxLoadError] = useState(false)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [messagesAccountId, setMessagesAccountId] = useState<string | null>(null)
  const [nextPageToken, setNextPageToken] = useState<string | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [threadMessages, setThreadMessages] = useState<MailMessage[]>([])
  const loadedThreadIdRef = useRef<string | null>(null)
  const mainCanvasRef = useRef<HTMLElement>(null)
  const readerBackButtonRef = useRef<HTMLButtonElement>(null)
  const [isReaderDetailsOpen, setIsReaderDetailsOpen] = useState(false)
  const [isReaderScrolled, setIsReaderScrolled] = useState(false)
  const [loadingMessageId, setLoadingMessageId] = useState<string | null>(null)
  const [messageLoadErrorId, setMessageLoadErrorId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<MailFilter>('all')
  const [activeView, setActiveView] = useState<'mail' | 'settings'>('mail')
  const [openAddAccount, setOpenAddAccount] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number; returnFocusElement: HTMLButtonElement } | null>(null)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [defaultAccountId, setDefaultAccountId] = useState('')
  const [toastMessage, setToastMessage] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [pendingPermanentDeleteId, setPendingPermanentDeleteId] = useState<string | null>(null)
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null)
  const [isReplying, setIsReplying] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null)
  const [isSendingReply, setIsSendingReply] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [composeRecipient, setComposeRecipient] = useState('')
  const [composeCc, setComposeCc] = useState('')
  const [composeBcc, setComposeBcc] = useState('')
  const [composeSubject, setComposeSubject] = useState('')
  const [composeBody, setComposeBody] = useState('')
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [messageActionInFlightId, setMessageActionInFlightId] = useState<string | null>(null)
  const [providerCapabilities, setProviderCapabilities] = useState<ProviderCapabilities | null>(null)
  const [providerCapabilitiesAccountId, setProviderCapabilitiesAccountId] = useState<string | null>(null)
  const syncInFlightRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const suppressSearchFocusRef = useRef(false)
  const searchRequestIdRef = useRef(0)
  const allowWindowCloseRef = useRef(false)
  const [isCloseConfirmationOpen, setIsCloseConfirmationOpen] = useState(false)
  const composeDraftStorageKey = activeAccountId ? `openmail.compose-draft.${activeAccountId}` : null
  const activeProviderCapabilities = providerCapabilitiesAccountId === activeAccountId ? providerCapabilities : null

  const updateComposeRecipient = (value: string) => { setComposeRecipient(value); setDraftStatus('saving') }
  const updateComposeCc = (value: string) => { setComposeCc(value); setDraftStatus('saving') }
  const updateComposeBcc = (value: string) => { setComposeBcc(value); setDraftStatus('saving') }
  const updateComposeSubject = (value: string) => { setComposeSubject(value); setDraftStatus('saving') }
  const updateComposeBody = (value: string) => { setComposeBody(value); setDraftStatus('saving') }

  const selectableMessages = useMemo(
    () => activeView === 'mail'
      ? activeFolder !== 'inbox' ? folderMessages : messagesAccountId === activeAccountId ? messages : []
      : [],
    [activeAccountId, activeFolder, activeView, folderMessages, messages, messagesAccountId],
  )
  const selectableMessagesRef = useRef<MailMessage[]>([])

  const clearReaderSelection = useCallback(() => {
    setSelectedMessageId(null)
    setLoadingMessageId(null)
    setMessageLoadErrorId(null)
    setIsReaderDetailsOpen(false)
    setIsReaderScrolled(false)
    setIsReplying(false)
    setReplyDraft('')
  }, [setIsReaderDetailsOpen, setIsReaderScrolled, setIsReplying, setLoadingMessageId, setMessageLoadErrorId, setReplyDraft, setSelectedMessageId])

  const dismissSearch = useCallback((restoreFocus = false) => {
    setIsSearchOpen(false)
    setSearchActiveIndex(0)
    if (restoreFocus) {
      suppressSearchFocusRef.current = true
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus()
        suppressSearchFocusRef.current = false
      })
    }
  }, [])

  const clearSearch = useCallback(() => {
    searchRequestIdRef.current += 1
    setSearchQuery('')
    setSearchResults([])
    setSearchPageTokens({})
    setIsSearchOpen(false)
    setIsSearchingMail(false)
    setSearchError(false)
    setSearchPartialError(false)
    setSearchActiveIndex(0)
  }, [])

  useEffect(() => {
    selectableMessagesRef.current = selectableMessages
  }, [selectableMessages])

  useEffect(() => {
    if (!isComposing || !composeDraftStorageKey) return
    const draft = { recipient: composeRecipient, cc: composeCc, bcc: composeBcc, subject: composeSubject, body: composeBody }
    const timeoutId = window.setTimeout(() => {
      if (!draft.recipient.trim() && !draft.subject.trim() && !draft.body.trim()) {
        window.localStorage.removeItem(composeDraftStorageKey)
        setDraftStatus('saved')
        return
      }
      window.localStorage.setItem(composeDraftStorageKey, JSON.stringify(draft))
      setDraftStatus('saved')
    }, 250)
    return () => window.clearTimeout(timeoutId)
  }, [composeBcc, composeBody, composeCc, composeDraftStorageKey, composeRecipient, composeSubject, isComposing])

  const loadAccounts = useCallback(() => {
    if (!isTauriRuntime()) return
    void invoke<MailAccount[]>('list_accounts').then((loadedAccounts) => {
      setAccounts(loadedAccounts)
      setIsLoadingAccounts(false)
      setAccountLoadError(false)
      const defaultAccount = loadedAccounts.find((account) => account.is_default) ?? loadedAccounts[0]
      if (!defaultAccount) {
        setActiveAccountId('')
        setDefaultAccountId('')
        setIsLoadingMessages(false)
        setMessages([])
        setMessagesAccountId(null)
        setNextPageToken(null)
        setFolderMessages([])
        setFolderNextPageToken(null)
        setIsLoadingFolder(false)
        setActiveFolder('inbox')
        setActiveFilter('all')
        clearSearch()
        clearReaderSelection()
        setContextMenu(null)
        return
      }
      setIsLoadingMessages(true)
      setMailboxLoadError(false)
      setActiveAccountId(defaultAccount.id)
      setDefaultAccountId(defaultAccount.id)
    }).catch(() => {
      setAccounts([])
      setIsLoadingAccounts(false)
      setAccountLoadError(true)
      setIsLoadingMessages(false)
      setActiveAccountId('')
      setDefaultAccountId('')
      setMessages([])
      setMessagesAccountId(null)
      setNextPageToken(null)
      setFolderMessages([])
      setFolderNextPageToken(null)
      setIsLoadingFolder(false)
      setActiveFolder('inbox')
      setActiveFilter('all')
      clearSearch()
      clearReaderSelection()
      setContextMenu(null)
    })
  }, [clearReaderSelection, clearSearch, setContextMenu])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  const retryAccountLoad = () => {
    setIsLoadingAccounts(true)
    setAccountLoadError(false)
    loadAccounts()
  }

  useEffect(() => {
    if (!isTauriRuntime() || !activeAccountId) return
    let cancelled = false
    void invoke<ProviderCapabilities>('get_provider_capabilities', { accountId: activeAccountId })
      .then((capabilities) => {
        if (!cancelled) {
          setProviderCapabilitiesAccountId(activeAccountId)
          setProviderCapabilities(capabilities)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProviderCapabilitiesAccountId(null)
          setProviderCapabilities(null)
          setToastMessage(getDisplayError(error))
        }
      })
    return () => { cancelled = true }
  }, [activeAccountId, getDisplayError])

  useEffect(() => {
    if (!isTauriRuntime()) return
    if (!activeAccountId || activeView !== 'mail') {
      return
    }
    let cancelled = false
    void invoke<MessagePage | null>('get_cached_messages', { accountId: activeAccountId })
      .then((cachedPage) => {
        if (cancelled || !cachedPage) return
        setMessages(cachedPage.messages)
        setNextPageToken(cachedPage.next_page_token)
        setMessagesAccountId(activeAccountId)
        setIsLoadingMessages(false)
        setMailboxLoadError(false)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMailboxLoadError(true)
          setToastMessage(getDisplayError(error))
        }
      })
    void invoke<SyncResult>('sync_messages', { accountId: activeAccountId })
      .then(({ page }) => {
        setAccountSyncStatus((current) => ({ ...current, [activeAccountId]: 'idle' }))
        if (cancelled) return
        setMessages((current) => mergeMessageLists(current, page.messages))
        setNextPageToken(page.next_page_token)
        setMessagesAccountId(activeAccountId)
        setMailboxLoadError(false)
      })
      .catch((error: unknown) => {
        setAccountSyncStatus((current) => ({ ...current, [activeAccountId]: 'error' }))
        if (!cancelled) {
          setMailboxLoadError(true)
          setToastMessage(getDisplayError(error))
        }
      })
      .finally(() => { if (!cancelled) setIsLoadingMessages(false) })
    return () => { cancelled = true }
  }, [activeAccountId, activeView, getDisplayError])

  useEffect(() => {
    if (accounts.length === 0) return
    let cancelled = false
    const sync = () => {
      if (syncInFlightRef.current) return
      syncInFlightRef.current = true
      setAccountSyncStatus((current) => accounts.reduce((next, account) => ({ ...next, [account.id]: 'syncing' as const }), current))
      void Promise.allSettled(accounts.map((account) => invoke<SyncResult>('sync_messages', { accountId: account.id })))
        .then(async (results) => {
          if (cancelled) return
          const notificationTargets: Array<{ accountId: string; count: number }> = []
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              setAccountSyncStatus((current) => ({ ...current, [accounts[index].id]: 'error' }))
              setToastMessage(getDisplayError(result.reason))
              return
            }
            setAccountSyncStatus((current) => ({ ...current, [accounts[index].id]: 'idle' }))
            if (result.value.new_message_count > 0) notificationTargets.push({ accountId: accounts[index].id, count: result.value.new_message_count })
            if (!cancelled && accounts[index].id === activeAccountId) {
              setMessages((current) => mergeMessageLists(current, result.value.page.messages))
              setNextPageToken(result.value.page.next_page_token)
              setMessagesAccountId(activeAccountId)
            }
          })
          if (cancelled || notificationTargets.length === 0 || !settings.notificationsEnabled || isQuietHours(settings)) return
          let permissionGranted = await isPermissionGranted()
          if (!permissionGranted) permissionGranted = (await requestPermission()) === 'granted'
          if (permissionGranted) {
            notificationTargets.forEach(({ accountId, count }) => sendNotification({
              title: t('newMailNotificationTitle'),
              body: t('newMailNotificationBody', { count }),
              sound: getNotificationSound(settings),
              extra: { accountId },
              autoCancel: true,
            }))
          }
        })
        .finally(() => { syncInFlightRef.current = false })
    }
    let intervalId = window.setInterval(sync, document.visibilityState === 'visible' ? foregroundSyncIntervalMs : backgroundSyncIntervalMs)
    const scheduleNextSync = () => {
      window.clearInterval(intervalId)
      intervalId = window.setInterval(sync, document.visibilityState === 'visible' ? foregroundSyncIntervalMs : backgroundSyncIntervalMs)
    }
    const handleWindowFocus = () => sync()
    const handleVisibilityChange = () => {
      scheduleNextSync()
      if (document.visibilityState === 'visible') sync()
    }
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [accounts, activeAccountId, activeView, getDisplayError, settings, t])

  useEffect(() => {
    const query = searchQuery.trim()
    const requestId = searchRequestIdRef.current + 1
    searchRequestIdRef.current = requestId
    if (!isTauriRuntime() || accounts.length === 0 || query.length < 2) return
    let cancelled = false
    const search = async () => {
      // Start local and network lookups together so a slow cache read cannot delay remote results.
      const cachedResponsesPromise = Promise.allSettled(accounts.map((account) => invoke<MessagePage>('search_cached_messages', { accountId: account.id, query })))
      const remoteResponsesPromise = Promise.allSettled(accounts.map((account) => invoke<MessagePage>('search_messages', { accountId: account.id, query })))
      const cachedResponses = await cachedResponsesPromise
      if (cancelled || requestId !== searchRequestIdRef.current) return
      const cachedResults = cachedResponses.flatMap((response, index) => response.status === 'fulfilled' && response.value
        ? response.value.messages.map((message) => ({ account: accounts[index], message }))
        : [])
      setSearchPageTokens(Object.fromEntries(accounts.map((account) => [account.id, null])))
      if (cachedResults.length > 0) setSearchResults(mergeSearchResults([], cachedResults))

      const remoteResponses = await remoteResponsesPromise
      if (cancelled || requestId !== searchRequestIdRef.current) return
      const remoteResults = remoteResponses.flatMap((response, index) => response.status === 'fulfilled'
        ? response.value.messages.map((message) => ({ account: accounts[index], message }))
        : [])
      const successfulAccountCount = remoteResponses.filter((response) => response.status === 'fulfilled').length
      const failedAccountCount = accounts.length - successfulAccountCount
      const combinedResults = mergeSearchResults(cachedResults, remoteResults)
      setSearchResults(combinedResults)
      setSearchPageTokens((current) => {
        const next = { ...current }
        remoteResponses.forEach((response, index) => {
          if (response.status === 'fulfilled') next[accounts[index].id] = response.value.next_page_token
        })
        return next
      })
      setIsSearchingMail(false)
      setSearchError(successfulAccountCount === 0 && cachedResults.length === 0)
      setSearchPartialError(failedAccountCount > 0 && successfulAccountCount > 0)
      remoteResponses.forEach((response, index) => {
        if (response.status !== 'fulfilled') return
        void invoke('cache_search_messages', { accountId: accounts[index].id, query, page: response.value, append: false }).catch((error: unknown) => {
          if (!cancelled && requestId === searchRequestIdRef.current) setToastMessage(getDisplayError(error))
        })
      })
    }
    const timeoutId = window.setTimeout(() => {
      if (cancelled || requestId !== searchRequestIdRef.current) return
      setIsSearchOpen(true)
      setIsSearchingMail(true)
      setSearchError(false)
      setSearchPartialError(false)
      setSearchResults([])
      setSearchActiveIndex(0)
      void search()
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [accounts, getDisplayError, searchQuery, searchRetryNonce])

  useEffect(() => {
    if (!activeAccountId || activeFolder === 'inbox' || activeView !== 'mail') return
    let cancelled = false
    const folder = activeFolder
    void invoke<MessagePage | null>('get_cached_folder_messages', { accountId: activeAccountId, folder })
      .then((cachedPage) => {
        if (cancelled || !cachedPage) return
        setFolderMessages(cachedPage.messages)
        setFolderNextPageToken(cachedPage.next_page_token)
        setIsLoadingFolder(false)
        setMailboxLoadError(false)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMailboxLoadError(true)
          setToastMessage(getDisplayError(error))
        }
      })
    void invoke<MessagePage>('list_folder_messages', { accountId: activeAccountId, folder })
      .then((page) => {
        if (!cancelled) {
          setFolderMessages((current) => mergeMessageLists(current, page.messages))
          setFolderNextPageToken(page.next_page_token)
          setMailboxLoadError(false)
          void invoke('cache_folder_messages', { accountId: activeAccountId, folder, page, append: false }).catch((error: unknown) => {
            if (!cancelled) setToastMessage(getDisplayError(error))
          })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMailboxLoadError(true)
          setToastMessage(getDisplayError(error))
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingFolder(false)
      })
    return () => { cancelled = true }
  }, [activeAccountId, activeFolder, activeView, getDisplayError])

  const loadNextPage = () => {
    if (!activeAccountId || !visibleNextPageToken || isLoadingMore) return
    const requestedAccountId = activeAccountId
    const requestedFolder = activeFolder
    setIsLoadingMore(true)
    const loadPage = activeFolder === 'inbox'
      ? invoke<MessagePage>('list_messages', { accountId: activeAccountId, pageToken: visibleNextPageToken })
      : invoke<MessagePage>('list_folder_messages', { accountId: activeAccountId, folder: activeFolder, pageToken: visibleNextPageToken })
    void loadPage
      .then((page) => {
        if (requestedAccountId !== activeAccountId || requestedFolder !== activeFolder) return
        setMailboxLoadError(false)
        if (activeFolder === 'inbox') {
          setMessages((current) => [...current, ...page.messages.filter((message) => !current.some((item) => item.id === message.id))])
          setNextPageToken(page.next_page_token)
        } else {
          setFolderMessages((current) => [...current, ...page.messages.filter((message) => !current.some((item) => item.id === message.id))])
          setFolderNextPageToken(page.next_page_token)
          void invoke('cache_folder_messages', { accountId: activeAccountId, folder: activeFolder, page, append: true }).catch((error: unknown) => setToastMessage(getDisplayError(error)))
        }
      })
      .catch((error: unknown) => {
        setMailboxLoadError(true)
        setToastMessage(getDisplayError(error))
      })
      .finally(() => setIsLoadingMore(false))
  }

  useEffect(() => {
    if (!selectedMessageId || !activeAccountId || activeView !== 'mail') return
    let cancelled = false
    const cachedMessage = selectableMessagesRef.current.find((message) => message.id === selectedMessageId)
    const threadId = cachedMessage?.thread_id
    const hasCachedBody = Boolean(cachedMessage && (cachedMessage.body_html || (cachedMessage.body && cachedMessage.body !== cachedMessage.preview)))
    if (threadId) {
      if (loadedThreadIdRef.current === threadId) return
      loadedThreadIdRef.current = threadId
      let canRenderCachedThread = hasCachedBody
      const applyThreadMessages = (loadedMessages: MailMessage[]) => {
        setThreadMessages(loadedMessages)
        setMessages((current) => appendUniqueMessages(current, loadedMessages))
        setFolderMessages((current) => appendUniqueMessages(current, loadedMessages))
      }
      void invoke<MailMessage[] | null>('get_cached_thread', { accountId: activeAccountId, threadId })
        .then((cachedMessages) => {
          if (cancelled || !cachedMessages?.length) return
          const cachedSelectedMessage = cachedMessages.find((message) => message.id === selectedMessageId)
          canRenderCachedThread = Boolean(cachedSelectedMessage && (cachedSelectedMessage.body_html || (cachedSelectedMessage.body && cachedSelectedMessage.body !== cachedSelectedMessage.preview)))
          applyThreadMessages(cachedMessages)
          if (canRenderCachedThread) {
            setMessageLoadErrorId(null)
            setLoadingMessageId(null)
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setToastMessage(getDisplayError(error))
        })
      void invoke<MailMessage[]>('get_thread', { accountId: activeAccountId, threadId })
        .then((loadedMessages) => {
          if (loadedMessages.length === 0) throw new Error('EMPTY_CONVERSATION')
          if (cancelled) return
          applyThreadMessages(loadedMessages)
          setMessageLoadErrorId(null)
          setLoadingMessageId(null)
        })
        .catch((error: unknown) => {
          if (cancelled) return
          if (canRenderCachedThread) {
            setMessageLoadErrorId(null)
          } else {
            setMessageLoadErrorId(selectedMessageId)
            setToastMessage(getDisplayError(error))
          }
          setLoadingMessageId(null)
        })
      return () => { cancelled = true }
    }
    if (hasCachedBody) return
    if (loadingMessageId !== selectedMessageId) return
    void invoke<MailMessage>('get_message', { accountId: activeAccountId, messageId: selectedMessageId })
      .then((loadedMessage) => {
        if (cancelled) return
          setMessages((current) => current.map((message) => message.id === loadedMessage.id ? loadedMessage : message))
          setFolderMessages((current) => current.map((message) => message.id === loadedMessage.id ? loadedMessage : message))
          setMessageLoadErrorId((current) => current === selectedMessageId ? null : current)
          setLoadingMessageId((current) => current === selectedMessageId ? null : current)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setToastMessage(getDisplayError(error))
        setMessageLoadErrorId(selectedMessageId)
        setLoadingMessageId((current) => current === selectedMessageId ? null : current)
      })
  }, [activeAccountId, activeView, getDisplayError, loadingMessageId, selectedMessageId])

  useEffect(() => {
    const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)')
    const applyTheme = () => {
      document.documentElement.dataset.theme = settings.theme === 'system' && systemThemeQuery.matches ? 'light' : settings.theme === 'system' ? 'dark' : settings.theme
    }
    applyTheme()
    systemThemeQuery.addEventListener('change', applyTheme)
    document.documentElement.lang = settings.language
    document.documentElement.style.setProperty('--app-font-scale', String(settings.fontScale))
    document.documentElement.style.setProperty('--reader-font-scale', String(settings.readerFontScale))
    document.documentElement.dataset.density = settings.density
    return () => systemThemeQuery.removeEventListener('change', applyTheme)
  }, [settings])

  useEffect(() => {
    if (!isTauriRuntime()) return
    const window = getCurrentWindow()
    const unlisten = window.onCloseRequested((event) => {
      if (settings.closeToTray) {
        event.preventDefault()
        void window.hide()
        return
      }
      if (allowWindowCloseRef.current || !settings.confirmOnClose) return
      event.preventDefault()
      setIsCloseConfirmationOpen(true)
    })
    return () => { void unlisten.then((removeListener) => removeListener()) }
  }, [settings.closeToTray, settings.confirmOnClose])

  useEffect(() => {
    if (!toastMessage) return
    const timeoutId = window.setTimeout(() => setToastMessage(''), 2200)
    return () => window.clearTimeout(timeoutId)
  }, [toastMessage])

  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? accounts[0]
  const visibleMessages = selectableMessages
  const visibleNextPageToken = activeView === 'mail'
    ? activeFolder === 'inbox' && messagesAccountId === activeAccountId ? nextPageToken : activeFolder !== 'inbox' ? folderNextPageToken : null
    : null
  const selectedMessage = visibleMessages.find((message) => message.id === selectedMessageId) ?? null
  const selectedMessageSubject = selectedMessage?.subject || t('noSubject')
  const selectedMessageSender = selectedMessage ? getSenderLabel(selectedMessage.sender, selectedMessage.address) : ''
  const selectedMessageTime = selectedMessage ? formatMessageTime(selectedMessage.time, settings, i18n.language) : ''
  const filteredMessages = visibleMessages.filter((message) => {
    const matchesFilter = activeFilter === 'all' || (activeFilter === 'unread' && message.unread) || (activeFilter === 'starred' && message.starred) || (activeFilter === 'attachments' && message.hasAttachment)
    return matchesFilter
  })
  const emptyListCopy = activeFilter === 'unread'
      ? { title: t('noUnreadMail'), description: t('noUnreadMailDescription') }
      : activeFilter === 'starred'
        ? { title: t('noStarredMail'), description: t('noStarredMailDescription') }
        : activeFilter === 'attachments'
          ? { title: t('noAttachmentMail'), description: t('noAttachmentMailDescription') }
          : activeFolder === 'inbox'
            ? { title: t('emptyInbox'), description: t('emptyInboxDescription') }
            : { title: t('emptyFolder', { folder: t(activeFolder) }), description: t('emptyFolderDescription') }
  const emptyListIcon = activeFilter === 'all' ? activeFolder : activeFilter
  const readerArchiveAction: MessageAction = activeFolder === 'spam' ? 'not_spam' : activeFolder === 'trash' ? 'untrash' : 'archive'
  const readerDeleteAction: MessageAction = activeFolder === 'trash' ? 'delete_forever' : 'trash'
  const isMailboxBusy = isLoadingAccounts || isLoadingFolder || isLoadingMessages
  const shouldShowLoadingSkeleton = isMailboxBusy && visibleMessages.length === 0
  const shouldShowInlineLoading = (isLoadingFolder || isLoadingMessages || isLoadingMore) && visibleMessages.length > 0
  const shouldShowMobileReader = !selectedMessageId && (accounts.length === 0 || isMailboxBusy)
  const accountTabStopId = accounts.find((account) => account.id === activeAccountId)?.id ?? accounts[0]?.id

  const handleMailRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, messageId: string) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const currentIndex = filteredMessages.findIndex((message) => message.id === messageId)
    if (currentIndex < 0) return
    const nextIndex = event.key === 'ArrowDown' ? Math.min(currentIndex + 1, filteredMessages.length - 1) : event.key === 'ArrowUp' ? Math.max(currentIndex - 1, 0) : event.key === 'Home' ? 0 : filteredMessages.length - 1
    if (nextIndex === currentIndex) return
    event.preventDefault()
    const nextMessage = filteredMessages[nextIndex]
    document.querySelector<HTMLButtonElement>(`[data-mail-id="${CSS.escape(nextMessage.id)}"]`)?.focus()
  }

  const handleAccountKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, accountId: string) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const currentIndex = accounts.findIndex((account) => account.id === accountId)
    if (currentIndex < 0) return
    const nextIndex = event.key === 'ArrowDown' ? Math.min(currentIndex + 1, accounts.length - 1) : event.key === 'ArrowUp' ? Math.max(currentIndex - 1, 0) : event.key === 'Home' ? 0 : accounts.length - 1
    if (nextIndex === currentIndex) return
    const nextAccountId = accounts[nextIndex]?.id
    if (!nextAccountId) return
    const nextButton = Array.from(accountListRef.current?.querySelectorAll<HTMLButtonElement>('[data-account-id]') ?? []).find((button) => button.dataset.accountId === nextAccountId)
    if (!nextButton) return
    event.preventDefault()
    nextButton.focus()
  }

  const selectMailFilter = (filter: MailFilter) => {
    const nextFilter: MailFilter = filter === activeFilter ? 'all' : filter
    if (nextFilter !== activeFilter) clearReaderSelection()
    setActiveFilter(nextFilter)
    if (nextFilter === 'starred') {
      setActiveFolder('starred')
      setIsLoadingFolder(true)
      setFolderMessages([])
      setFolderNextPageToken(null)
      dismissSearch()
    } else if (activeFolder === 'starred') {
      setActiveFolder('inbox')
      setIsLoadingFolder(false)
      setFolderMessages([])
      setFolderNextPageToken(null)
    }
  }

  const selectAccount = (accountId: string) => {
    const accountChanged = accountId !== activeAccountId
    clearReaderSelection()
    clearSearch()
    setActiveFolder('inbox')
    setActiveFilter('all')
    setFolderMessages([])
    setFolderNextPageToken(null)
    setIsLoadingFolder(false)
    setActiveView('mail')
    if (!accountChanged) return
    setIsLoadingMessages(true)
    setMessages([])
    setMessagesAccountId(null)
    setNextPageToken(null)
    setActiveAccountId(accountId)
  }

  const handleMailFilterKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, filter: MailFilter) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const filters: MailFilter[] = ['unread', 'starred', 'attachments']
    const currentIndex = filters.indexOf(filter)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? filters.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + filters.length) % filters.length
    const nextFilter = filters[nextIndex]
    selectMailFilter(nextFilter)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-mail-filter="${nextFilter}"]`)?.focus()
    })
  }

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('[data-context-menu="mail"]')) {
      event.preventDefault()
      setContextMenu(null)
    }
  }

  const handleMailContextMenu = (messageId: string, x: number, y: number, returnFocusElement: HTMLButtonElement) => {
    setContextMenu({ messageId, x: Math.min(x, window.innerWidth - 210), y: Math.min(y, window.innerHeight - 190), returnFocusElement })
  }

  const handleReaderLinkClick = useCallback((href: string) => {
    void invoke('open_external_url', { url: href }).catch((error: unknown) => {
      setToastMessage(getDisplayError(error))
    })
  }, [getDisplayError, setToastMessage])

  const updateMessage = useCallback((messageId: string, update: Partial<MailMessage>) => {
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, ...update } : message))
    setFolderMessages((current) => current.map((message) => message.id === messageId ? { ...message, ...update } : message))
    setThreadMessages((current) => current.map((message) => message.id === messageId ? { ...message, ...update } : message))
  }, [])

  const removeMessageEverywhere = (messageId: string) => {
    setMessages((current) => current.filter((message) => message.id !== messageId))
    setFolderMessages((current) => current.filter((message) => message.id !== messageId))
  }

  const removeMessageFromInbox = (messageId: string) => {
    setMessages((current) => current.filter((message) => message.id !== messageId))
  }

  const isActionAvailable = useCallback((action: MessageAction) => {
    if (!activeProviderCapabilities) return false
    switch (action) {
      case 'archive': return activeProviderCapabilities.can_archive
      case 'trash':
      case 'untrash': return activeProviderCapabilities.can_delete
      case 'delete_forever': return activeProviderCapabilities.can_permanently_delete
      case 'mark_read':
      case 'mark_unread': return activeProviderCapabilities.can_mark_read
      case 'star':
      case 'unstar': return activeProviderCapabilities.can_star
      case 'spam':
      case 'not_spam': return activeProviderCapabilities.can_spam
    }
  }, [activeProviderCapabilities])

  const runMessageAction = useCallback((messageId: string, action: MessageAction, onSuccess: () => void) => {
    if (!activeAccountId || messageActionInFlightId || !isActionAvailable(action)) return
    const requestedAccountId = activeAccountId
    setMessageActionInFlightId(messageId)
    void invoke('modify_message', { accountId: requestedAccountId, messageId, action })
      .then(() => {
        if (requestedAccountId === activeAccountId) onSuccess()
      })
      .catch((error: unknown) => setToastMessage(getDisplayError(error)))
      .finally(() => setMessageActionInFlightId((current) => current === messageId ? null : current))
  }, [activeAccountId, getDisplayError, isActionAvailable, messageActionInFlightId, setToastMessage])

  const archiveMessage = (messageId: string) => {
    runMessageAction(messageId, 'archive', () => {
      removeMessageFromInbox(messageId)
      setSelectedMessageId(null)
      setContextMenu(null)
      setToastMessage(t('archiveComplete'))
      setIsReplying(false)
      setReplyDraft('')
    })
  }

  const requestArchiveMessage = (messageId: string) => {
    setContextMenu(null)
    if (settings.confirmActions) {
      setPendingArchiveId(messageId)
      return
    }
    archiveMessage(messageId)
  }

  const requestDeleteMessage = (messageId: string) => {
    setContextMenu(null)
    if (activeFolder === 'trash') {
      if (!settings.confirmActions) {
        permanentlyDeleteMessage(messageId)
        return
      }
      setPendingPermanentDeleteId(messageId)
      return
    }
    if (!settings.confirmActions) {
      confirmDeleteMessage(messageId)
      return
    }
    setPendingDeleteId(messageId)
  }

  const permanentlyDeleteMessage = (messageId: string) => {
    runMessageAction(messageId, 'delete_forever', () => {
      removeMessageEverywhere(messageId)
      setSelectedMessageId(null)
      setPendingPermanentDeleteId(null)
      setToastMessage(t('permanentDeleteComplete'))
      setIsReplying(false)
      setReplyDraft('')
    })
  }

  const cancelPermanentDeleteMessage = () => {
    setPendingPermanentDeleteId(null)
  }

  const moveMessageToSpam = (messageId: string) => {
    runMessageAction(messageId, 'spam', () => {
      removeMessageEverywhere(messageId)
      setSelectedMessageId(null)
      setContextMenu(null)
      setToastMessage(t('spamComplete'))
    })
  }

  const restoreMessage = (messageId: string) => {
    const action = activeFolder === 'spam' ? 'not_spam' : 'untrash'
    runMessageAction(messageId, action, () => {
      removeMessageEverywhere(messageId)
      setSelectedMessageId(null)
      setContextMenu(null)
      setToastMessage(t(action === 'not_spam' ? 'notSpamComplete' : 'restoreComplete'))
    })
  }

  const confirmDeleteMessage = (requestedMessageId?: string) => {
    const messageId = requestedMessageId ?? pendingDeleteId
    if (!messageId) return
    runMessageAction(messageId, 'trash', () => {
      removeMessageEverywhere(messageId)
      setSelectedMessageId(null)
      setPendingDeleteId(null)
      setToastMessage(t('deleteComplete'))
      setIsReplying(false)
      setReplyDraft('')
    })
  }

  const cancelDeleteMessage = () => {
    setPendingDeleteId(null)
  }

  const confirmArchiveMessage = () => {
    if (!pendingArchiveId) return
    archiveMessage(pendingArchiveId)
    setPendingArchiveId(null)
  }

  const cancelArchiveMessage = () => {
    setPendingArchiveId(null)
  }

  const markMessageUnread = (messageId: string) => {
    runMessageAction(messageId, 'mark_unread', () => {
      updateMessage(messageId, { unread: true })
      setContextMenu(null)
      setToastMessage(t('markUnreadComplete'))
    })
  }

  const markMessageRead = useCallback((messageId: string) => {
    runMessageAction(messageId, 'mark_read', () => updateMessage(messageId, { unread: false }))
  }, [runMessageAction, updateMessage])

  const markMessageReadFromContext = (messageId: string) => {
    runMessageAction(messageId, 'mark_read', () => {
      updateMessage(messageId, { unread: false })
      setContextMenu(null)
      setToastMessage(t('markReadComplete'))
    })
  }

  const starMessage = (messageId: string) => {
    const message = selectableMessages.find((item) => item.id === messageId)
    if (!message) return
    runMessageAction(messageId, message.starred ? 'unstar' : 'star', () => {
      updateMessage(messageId, { starred: !message.starred })
      setContextMenu(null)
      setToastMessage(t('starComplete'))
    })
  }

  const downloadAttachment = (attachment: Pick<MailAttachment, 'id' | 'filename'>, messageId = selectedMessageId) => {
    if (!activeAccountId || !messageId || downloadingAttachmentId) return
    setDownloadingAttachmentId(attachment.id)
    void invoke<string>('download_attachment', {
      accountId: activeAccountId,
      messageId,
      attachmentId: attachment.id,
      filename: attachment.filename,
    })
      .then(() => setToastMessage(t('attachmentDownloaded')))
      .catch((error: unknown) => setToastMessage(getDisplayError(error)))
      .finally(() => setDownloadingAttachmentId(null))
  }

  const updateSetting = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => {
    const next = { ...settings, [key]: value }
    setSettings(next)
    saveSettings(next)
    if (key === 'launchAtStartup') {
      void invoke('set_launch_at_startup', { enabled: next.launchAtStartup }).catch((error: unknown) => {
        const reverted = { ...next, launchAtStartup: !next.launchAtStartup }
        saveSettings(reverted)
        setSettings(reverted)
        setToastMessage(getDisplayError(error))
      })
    }
  }

  const setDefaultAccount = (accountId: string) => {
    void invoke<MailAccount[]>('set_default_account', { accountId }).then((updatedAccounts) => {
      setAccounts(updatedAccounts)
      setDefaultAccountId(accountId)
      setIsLoadingMessages(true)
      setMessages([])
      setMessagesAccountId(null)
      setNextPageToken(null)
      setFolderMessages([])
      setFolderNextPageToken(null)
      setIsLoadingFolder(false)
      clearSearch()
      clearReaderSelection()
      setActiveAccountId(accountId)
      setActiveFolder('inbox')
      setActiveFilter('all')
      setActiveView('mail')
    }).catch((error: unknown) => setToastMessage(getDisplayError(error)))
  }

  const refreshMailbox = async () => {
    if (!activeAccountId || isRefreshing || syncInFlightRef.current) return
    const requestedAccountId = activeAccountId
    const requestedFolder = activeFolder
    setIsRefreshing(true)
    syncInFlightRef.current = true
    try {
      if (activeFolder === 'inbox') {
        const result = await invoke<SyncResult>('sync_messages', { accountId: activeAccountId })
        if (requestedAccountId !== activeAccountId || requestedFolder !== activeFolder) return
        setMessages((current) => mergeMessageLists(current, result.page.messages))
        setNextPageToken(result.page.next_page_token)
        setMessagesAccountId(activeAccountId)
      } else {
        const folder = activeFolder
        const page = await invoke<MessagePage>('list_folder_messages', { accountId: activeAccountId, folder })
        if (requestedAccountId !== activeAccountId || requestedFolder !== activeFolder) return
        setFolderMessages((current) => mergeMessageLists(current, page.messages))
        setFolderNextPageToken(page.next_page_token)
        await invoke('cache_folder_messages', { accountId: activeAccountId, folder, page, append: false })
      }
      setToastMessage(t('syncComplete'))
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    } finally {
      syncInFlightRef.current = false
      setIsRefreshing(false)
    }
  }

  const requestWindowClose = () => {
    if (!isTauriRuntime()) return
    if (settings.closeToTray) {
      void getCurrentWindow().hide()
      return
    }
    if (settings.confirmOnClose) {
      setIsCloseConfirmationOpen(true)
      return
    }
    void getCurrentWindow().close()
  }

  const confirmWindowClose = () => {
    if (!isTauriRuntime()) return
    allowWindowCloseRef.current = true
    setIsCloseConfirmationOpen(false)
    void getCurrentWindow().close()
  }

  const removeAccount = (accountId: string) => {
    void invoke<MailAccount[]>('remove_account', { accountId })
      .then((updatedAccounts) => {
        setAccounts(updatedAccounts)
        const nextAccount = updatedAccounts.find((account) => account.is_default) ?? updatedAccounts[0]
        setDefaultAccountId(nextAccount?.id ?? '')
        if (activeAccountId === accountId) {
          setIsLoadingMessages(Boolean(nextAccount))
          setActiveAccountId(nextAccount?.id ?? '')
          setActiveFolder('inbox')
          setActiveFilter('all')
          setIsLoadingFolder(false)
          setFolderNextPageToken(null)
          setMessages([])
          setMessagesAccountId(null)
          setNextPageToken(null)
          setFolderMessages([])
          clearSearch()
          clearReaderSelection()
        }
        setToastMessage(t('accountRemoved'))
      })
      .catch((error: unknown) => setToastMessage(getDisplayError(error)))
  }

  const startAuth = async (provider: MailAccount['provider'], loginHint?: string) => {
    try {
      await invoke('start_auth', { provider, loginHint: loginHint ?? null })
    } catch (error) {
      const message = getDisplayError(error)
      setToastMessage(message)
      throw error
    }
    let attempts = 0
    await new Promise<void>((resolve, reject) => {
      const pollAuthState = window.setInterval(() => {
        attempts += 1
        void invoke<AuthState>('get_auth_status').then(async (authState) => {
          if (authState.status === 'connected') {
            window.clearInterval(pollAuthState)
            try {
              const loadedAccounts = await invoke<MailAccount[]>('list_accounts')
              setAccounts(loadedAccounts)
              setAccountLoadError(false)
              const defaultAccount = loadedAccounts.find((account) => account.is_default) ?? loadedAccounts[0]
              setDefaultAccountId(defaultAccount?.id ?? '')
              if (authState.account_id) {
                setIsLoadingMessages(true)
                setMessages([])
                setMessagesAccountId(null)
                setNextPageToken(null)
                setFolderMessages([])
                setFolderNextPageToken(null)
                setIsLoadingFolder(false)
                setActiveFilter('all')
                clearSearch()
                clearReaderSelection()
                setActiveAccountId(authState.account_id)
                setActiveFolder('inbox')
                setActiveView('mail')
              }
              resolve()
            } catch (error) {
              reject(error)
            }
          } else if (authState.status === 'failed') {
            window.clearInterval(pollAuthState)
            const message = getDisplayError(authState.error ?? t('authFailed'))
            setToastMessage(message)
            reject(new Error(message))
          } else if (attempts >= 600) {
            window.clearInterval(pollAuthState)
            const message = t('authTimedOut')
            setToastMessage(message)
            reject(new Error(message))
          }
        }).catch((error: unknown) => {
          window.clearInterval(pollAuthState)
          reject(error)
        })
      }, 500)
    })
  }

  const openReply = () => {
    if (!activeProviderCapabilities?.can_reply) return
    setIsReplying(true)
    setReplyDraft('')
  }

  const cancelReply = () => {
    setIsReplying(false)
    setReplyDraft('')
  }

  const closeReader = useCallback(() => {
    const messageId = selectedMessageId
    clearReaderSelection()
    if (!messageId) return
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-mail-id="${CSS.escape(messageId)}"]`)?.focus()
    })
  }, [clearReaderSelection, selectedMessageId])

  const handleReaderScroll = (event: UIEvent<HTMLElement>) => {
    const nextIsScrolled = event.currentTarget.scrollTop > 24
    setIsReaderScrolled((current) => current === nextIsScrolled ? current : nextIsScrolled)
  }

  useEffect(() => {
    if (!selectedMessageId || activeView !== 'mail') return
    const handleReaderKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelector('[role="dialog"]')) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
      event.preventDefault()
      closeReader()
    }
    window.addEventListener('keydown', handleReaderKeyDown)
    return () => window.removeEventListener('keydown', handleReaderKeyDown)
  }, [activeView, closeReader, selectedMessageId])

  useEffect(() => {
    const handleGlobalShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
      setContextMenu(null)
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    window.addEventListener('keydown', handleGlobalShortcut)
    return () => window.removeEventListener('keydown', handleGlobalShortcut)
  }, [])

  useEffect(() => {
    if (!isSearchOpen) return undefined
    const handleOutsidePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('[data-search-surface]')) dismissSearch()
    }
    window.addEventListener('pointerdown', handleOutsidePointerDown)
    return () => window.removeEventListener('pointerdown', handleOutsidePointerDown)
  }, [dismissSearch, isSearchOpen])

  const handleSearchQueryChange = (value: string) => {
    const query = value.trim()
    setContextMenu(null)
    setSearchQuery(value)
    setSearchResults([])
    setSearchPageTokens({})
    setSearchError(false)
    setSearchPartialError(false)
    setSearchActiveIndex(0)
    setIsSearchingMail(query.length >= 2 && isTauriRuntime() && accounts.length > 0)
    setIsSearchOpen(query.length >= 2)
  }

  const handleSearchFocus = () => {
    setContextMenu(null)
    if (suppressSearchFocusRef.current) return
    if (searchQuery.trim().length >= 2) setIsSearchOpen(true)
  }

  const retrySearch = () => {
    setSearchError(false)
    setSearchRetryNonce((current) => current + 1)
  }

  const loadMoreSearch = () => {
    const query = searchQuery.trim()
    const requestedSearchRequestId = searchRequestIdRef.current
    const accountsWithNextPage = accounts.filter((account) => searchPageTokens[account.id])
    if (!query || accountsWithNextPage.length === 0 || isLoadingMoreSearch) return
    setIsLoadingMoreSearch(true)
    const responsesPromise = Promise.allSettled(accountsWithNextPage.map((account) => invoke<MessagePage>('search_messages', {
      accountId: account.id,
      query,
      pageToken: searchPageTokens[account.id],
    })))
    void responsesPromise.then((responses) => {
      if (requestedSearchRequestId !== searchRequestIdRef.current || query !== searchQuery.trim()) return
      const nextResults = responses.flatMap((response, index) => response.status === 'fulfilled'
        ? response.value.messages.map((message) => ({ account: accountsWithNextPage[index], message }))
        : [])
      setSearchResults((current) => mergeSearchResults(current, nextResults))
      setSearchPageTokens((current) => {
        const next = { ...current }
        responses.forEach((response, index) => {
          if (response.status === 'fulfilled') next[accountsWithNextPage[index].id] = response.value.next_page_token
        })
        return next
      })
      responses.forEach((response, index) => {
        if (response.status !== 'fulfilled') return
        void invoke('cache_search_messages', { accountId: accountsWithNextPage[index].id, query, page: response.value, append: true }).catch((error: unknown) => {
          if (requestedSearchRequestId === searchRequestIdRef.current) setToastMessage(getDisplayError(error))
        })
      })
    }).finally(() => setIsLoadingMoreSearch(false))
  }

  const cacheSentMessage = async (messageId: string) => {
    const requestedAccountId = activeAccountId
    try {
      const sentMessage = await invoke<MailMessage>('cache_sent_message', { accountId: requestedAccountId, messageId })
      if (requestedAccountId === activeAccountId && activeFolder === 'sent') {
        setFolderMessages((current) => [sentMessage, ...current.filter((message) => message.id !== sentMessage.id)])
      }
    } catch (error) {
      setToastMessage(`${t('sentCacheFailed')} ${getDisplayError(error)}`)
    }
  }

  const submitReply = async () => {
    if (!selectedMessage || !activeAccount?.address || isSendingReply || !activeProviderCapabilities?.can_reply) return
    setIsSendingReply(true)
    const subject = /^re:/i.test(selectedMessage.subject.trim()) ? selectedMessage.subject : `Re: ${selectedMessage.subject}`
    try {
      const sentMessageId = await invoke<string>('send_reply', {
        accountId: activeAccountId,
        messageId: selectedMessage.id,
        sender: activeAccount.address,
        recipient: selectedMessage.address,
        subject,
        body: replyDraft,
        threadId: selectedMessage.thread_id,
        inReplyTo: selectedMessage.message_id_header,
      })
      setIsReplying(false)
      setReplyDraft('')
      setToastMessage(t('replySent'))
      void cacheSentMessage(sentMessageId)
    } catch (error) {
      setToastMessage(`${t('replySendFailed')} ${getDisplayError(error)}`)
    } finally {
      setIsSendingReply(false)
    }
  }

  const closeComposer = () => {
    if (isSendingMessage) return
    setIsComposing(false)
    setComposeRecipient('')
    setComposeCc('')
    setComposeBcc('')
    setComposeSubject('')
    setComposeBody('')
    setDraftStatus('idle')
  }

  const persistComposeDraft = () => {
    if (!composeDraftStorageKey) return
    const draft = { recipient: composeRecipient, cc: composeCc, bcc: composeBcc, subject: composeSubject, body: composeBody }
    if (!draft.recipient.trim() && !draft.cc.trim() && !draft.bcc.trim() && !draft.subject.trim() && !draft.body.trim()) return
    window.localStorage.setItem(composeDraftStorageKey, JSON.stringify(draft))
    setDraftStatus('saved')
  }

  const openComposer = () => {
    if (!activeProviderCapabilities?.can_send) return
    if (composeDraftStorageKey) {
      const storedDraft = window.localStorage.getItem(composeDraftStorageKey)
      if (storedDraft) {
        try {
          const parsedDraft: unknown = JSON.parse(storedDraft)
          if (isComposeDraft(parsedDraft)) {
            setComposeRecipient(parsedDraft.recipient)
            setComposeCc(parsedDraft.cc ?? '')
            setComposeBcc(parsedDraft.bcc ?? '')
            setComposeSubject(parsedDraft.subject)
            setComposeBody(parsedDraft.body)
          }
        } catch {
          window.localStorage.removeItem(composeDraftStorageKey)
        }
      }
    }
    setIsComposing(true)
    setDraftStatus('idle')
  }

  const submitMessage = async () => {
    if (!activeAccount?.address || !activeProviderCapabilities?.can_send || !areValidEmailAddresses(composeRecipient) || (composeCc.trim() && !areValidEmailAddresses(composeCc)) || (composeBcc.trim() && !areValidEmailAddresses(composeBcc)) || !composeSubject.trim() || !composeBody.trim() || isSendingMessage) return
    setIsSendingMessage(true)
    try {
      const sentMessageId = await invoke<string>('send_message', {
        accountId: activeAccountId,
        sender: activeAccount.address,
        recipient: splitEmailAddresses(composeRecipient).join(', '),
        cc: splitEmailAddresses(composeCc).join(', '),
        bcc: splitEmailAddresses(composeBcc).join(', '),
        subject: composeSubject.trim(),
        body: composeBody,
      })
      setIsComposing(false)
      setComposeRecipient('')
      setComposeCc('')
      setComposeBcc('')
      setComposeSubject('')
      setComposeBody('')
      if (composeDraftStorageKey) window.localStorage.removeItem(composeDraftStorageKey)
      setToastMessage(t('messageSent'))
      void cacheSentMessage(sentMessageId)
    } catch (error) {
      persistComposeDraft()
      setToastMessage(`${t('messageSendFailed')} ${getDisplayError(error)}`)
    } finally {
      setIsSendingMessage(false)
    }
  }

  const selectMessage = (messageId: string) => {
    const nextMessage = visibleMessages.find((item) => item.id === messageId)
    if (nextMessage) selectReaderMessage(nextMessage)
  }

  useLayoutEffect(() => {
    if (!selectedMessageId || activeView !== 'mail') return
    const canvas = mainCanvasRef.current
    if (!canvas) return
    canvas.scrollTop = 0
  }, [activeView, selectedMessageId])

  useEffect(() => {
    if (!selectedMessageId || activeView !== 'mail') return undefined
    const mobileViewport = window.matchMedia('(max-width: 580px)')
    const focusMobileReader = () => {
      if (mobileViewport.matches) readerBackButtonRef.current?.focus()
    }
    focusMobileReader()
    mobileViewport.addEventListener('change', focusMobileReader)
    return () => mobileViewport.removeEventListener('change', focusMobileReader)
  }, [activeView, selectedMessageId])

  const retryMessageLoad = (messageId: string) => {
    setMessageLoadErrorId(null)
    setThreadMessages([])
    loadedThreadIdRef.current = null
    setLoadingMessageId(messageId)
  }

  const selectReaderMessage = (nextMessage: MailMessage) => {
    const needsBody = !nextMessage.body_html && (!nextMessage.body || nextMessage.body === nextMessage.preview)
    setSelectedMessageId(nextMessage.id)
    setThreadMessages(nextMessage.body_html || (nextMessage.body && nextMessage.body !== nextMessage.preview) ? [nextMessage] : [])
    loadedThreadIdRef.current = null
    setMessageLoadErrorId(null)
    setIsReaderDetailsOpen(false)
    setIsReaderScrolled(false)
    setLoadingMessageId(needsBody ? nextMessage.id : null)
    setContextMenu(null)
    if (nextMessage.unread && !needsBody) markMessageRead(nextMessage.id)
  }

  const selectSearchResult = (result: MailSearchResult) => {
    const nextMessage = result.message
    const isCurrentAccount = result.account.id === messagesAccountId
    clearReaderSelection()
    clearSearch()
    setActiveView('mail')
    setActiveAccountId(result.account.id)
    setActiveFolder('inbox')
    setActiveFilter('all')
    setFolderMessages([])
    setFolderNextPageToken(null)
    setMessagesAccountId(result.account.id)
    setMessages((current) => isCurrentAccount ? mergeMessageLists(current, [nextMessage]) : [nextMessage])
    setNextPageToken(isCurrentAccount ? nextPageToken : null)
    setIsLoadingMessages(!isCurrentAccount)
    selectReaderMessage(nextMessage)
  }

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (!isSearchOpen) return
      event.preventDefault()
      dismissSearch(true)
      return
    }
    if (event.key === 'ArrowDown' && isSearchOpen && searchResults.length > 0) {
      event.preventDefault()
      setSearchActiveIndex(0)
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('[data-search-result-index="0"]')?.focus()
      })
      return
    }
    if (event.key === 'Enter' && isSearchOpen && searchResults[searchActiveIndex]) {
      event.preventDefault()
      selectSearchResult(searchResults[searchActiveIndex])
    }
  }

  return (
    <main className="app-shell" onContextMenu={handleContextMenu} onClick={() => setContextMenu(null)}>
      <WindowHeader
        onRequestClose={requestWindowClose}
        minimizeToTray={settings.minimizeToTray}
        searchQuery={searchQuery}
        searchDisabled={isLoadingAccounts || accounts.length === 0}
        searchLabel={isLoadingAccounts ? t('loadingAccounts') : accountLoadError ? t('accountsUnavailable') : accounts.length === 0 ? t('searchUnavailable') : t('searchMail')}
        searchCompactLabel={isLoadingAccounts ? t('loadingAccountsCompact') : accountLoadError ? t('accountsUnavailable') : accounts.length === 0 ? t('searchUnavailableCompact') : t('searchCompact')}
        searchOpen={isSearchOpen}
        searchInputRef={searchInputRef}
        onSearchQueryChange={handleSearchQueryChange}
        onSearchFocus={handleSearchFocus}
        onSearchKeyDown={handleSearchKeyDown}
        onClearSearch={clearSearch}
      >
        {isSearchOpen ? <MailSearchDialog
          results={searchResults}
          isSearching={isSearchingMail}
          hasError={searchError}
          hasPartialError={searchPartialError}
          activeIndex={searchActiveIndex}
          hasMore={Object.values(searchPageTokens).some((pageToken) => Boolean(pageToken))}
          isLoadingMore={isLoadingMoreSearch}
          providerLogos={providerLogos}
          labels={{
            title: t('searchResults'),
            resultCount: (count) => t('searchResultCount', { count }),
            searching: t('searchingConnectedAccounts'),
            noResults: t('noSearchResults'),
            noResultsDescription: t('noSearchResultsDescription'),
            searchFailed: t('searchFailed'),
            searchFailedDescription: t('searchFailedDescription'),
            tryAgain: t('tryAgain'),
            partialError: t('searchPartialError'),
            loadMore: t('loadMoreMail'),
            loadingMore: t('loadingMoreMail'),
            unread: t('unreadMail'),
            noSubject: t('noSubject'),
          }}
          formatTime={(value) => formatMessageTime(value, settings, i18n.language)}
          onClose={dismissSearch}
          onRetry={retrySearch}
          onSelect={selectSearchResult}
          onHighlight={setSearchActiveIndex}
          onLoadMore={loadMoreSearch}
        /> : null}
      </WindowHeader>
      <aside className="sidebar" aria-label={t('navigation')}>
        <nav ref={accountListRef} className="account-list" aria-label={t('accounts')}>
            {accounts.map((account) => (
              <AccountButton key={account.id} account={account} active={activeAccountId === account.id} syncStatus={accountSyncStatus[account.id] ?? 'idle'} providerLogos={providerLogos} tabIndex={account.id === accountTabStopId ? 0 : -1} onSelect={() => selectAccount(account.id)} onKeyDown={(event) => handleAccountKeyDown(event, account.id)} />
            ))}
        </nav>
        <div className="sidebar-footer">
          <button ref={settingsButtonRef} className={`settings-button ${activeView === 'settings' ? 'active' : ''}`} type="button" aria-label={t('settings')} title={t('settings')} aria-current={activeView === 'settings' ? 'page' : undefined} onClick={() => { setOpenAddAccount(false); setActiveView(activeView === 'settings' ? 'mail' : 'settings'); setContextMenu(null); clearSearch() }}>
            <IconSettings aria-hidden="true" size={18} stroke={1.8} />
          </button>
        </div>
      </aside>
      <section className={`content-area ${activeView === 'settings' ? 'settings-active' : ''} ${selectedMessageId && activeView === 'mail' ? 'reader-open' : ''} ${shouldShowMobileReader && activeView === 'mail' ? 'mobile-reader-empty' : ''}`}>
        <aside className={`main-sidebar ${activeAccount ? 'has-account' : 'no-account'}`} aria-label={t('mainSidebar')}>
          <div className="mail-sidebar-header">
            <div className="mail-sidebar-title-group">
              <h1>{activeFolder === 'inbox' ? t('inbox') : activeFolder === 'starred' ? t('starredMail') : t(activeFolder)}</h1>
              <span id="mail-account-status" aria-live="polite" dir={activeAccount ? 'ltr' : undefined}>{isLoadingAccounts ? t('loadingAccounts') : accountLoadError ? t('accountsUnavailable') : activeAccount?.address ?? t('noConnectedAccounts')}</span>
            </div>
            {activeAccount ? <div className="mail-sidebar-actions"><Button className="mail-refresh-button" variant="ghost" size="icon" type="button" disabled={isRefreshing} aria-busy={isRefreshing} aria-label={t('refreshMail')} title={t('refreshMail')} onClick={() => { void refreshMailbox() }}><IconRefresh className={isRefreshing ? 'is-spinning' : undefined} aria-hidden="true" size={16} stroke={1.8} /></Button></div> : null}
          </div>
          <div className="mail-sidebar-compose"><Button className="compose-button" type="button" disabled={!activeAccount || !activeProviderCapabilities?.can_send} aria-describedby={!activeAccount ? 'mail-account-status' : undefined} onClick={openComposer}><IconPencil aria-hidden="true" size={15} stroke={1.8} />{t('compose')}</Button></div>
          <nav className="mail-folder-nav" aria-labelledby="mail-folders-label">
            <span className="mail-section-label" id="mail-folders-label">{t('mailFolders')}</span>
            {[
              { id: 'inbox' as const, label: t('inbox'), icon: IconInbox },
              { id: 'sent' as const, label: t('sent'), icon: IconSend },
              { id: 'spam' as const, label: t('spam'), icon: IconAlertTriangle },
              { id: 'trash' as const, label: t('trash'), icon: IconTrash },
            ].map((folder) => {
              const Icon = folder.icon
              return <Button className={`folder-nav-item ${activeFolder === folder.id ? 'active' : ''}`} key={folder.id} variant="ghost" type="button" disabled={!activeAccount} aria-describedby={!activeAccount ? 'mail-account-status' : undefined} aria-current={activeFolder === folder.id ? 'page' : undefined} onClick={() => { clearReaderSelection(); dismissSearch(); setActiveFolder(folder.id); setIsLoadingFolder(folder.id !== 'inbox'); setActiveFilter(activeFilter === 'starred' ? 'all' : activeFilter); setFolderMessages([]); setFolderNextPageToken(null) }}><Icon aria-hidden="true" size={16} stroke={1.8} /><span>{folder.label}</span></Button>
            })}
          </nav>
          <div className="mail-filters">
            <span className="mail-section-label" id="mail-filters-label">{t('mailFilters')}</span>
            <div className="mail-filter-options" role="group" aria-labelledby="mail-filters-label">
              {(['unread', 'starred', 'attachments'] as const).map((filter) => (
                <button className={`mail-filter ${activeFilter === filter ? 'active' : ''}`} data-mail-filter={filter} key={filter} type="button" disabled={!activeAccount} aria-describedby={!activeAccount ? 'mail-account-status' : undefined} aria-pressed={activeFilter === filter} tabIndex={activeAccount && (activeFilter === filter || (activeFilter === 'all' && filter === 'unread')) ? 0 : -1} onClick={() => selectMailFilter(filter)} onKeyDown={(event) => handleMailFilterKeyDown(event, filter)}>
                  {t(`${filter}Mail`)}
                </button>
              ))}
            </div>
          </div>
          <div className="message-list" aria-busy={isLoadingAccounts || isLoadingFolder || isLoadingMessages}>
            {shouldShowInlineLoading ? <div className="message-list-syncing" role="status"><IconRefresh className="is-spinning" aria-hidden="true" size={14} stroke={1.8} />{t('updatingMail')}</div> : null}
            {!activeAccount && !isLoadingAccounts ? null : shouldShowLoadingSkeleton ? <div className="message-list-loading" role="status" aria-label={t('loadingMailbox')}>
              {[0, 1, 2, 3].map((item) => <div className="message-row-skeleton" key={item}>
                <div className="message-row-skeleton-head"><Skeleton className="message-row-skeleton-avatar" /><Skeleton className="message-row-skeleton-dot" /><Skeleton className="message-row-skeleton-sender" /><Skeleton className="message-row-skeleton-time" /></div>
                <Skeleton className="message-row-skeleton-subject" />
                <Skeleton className="message-row-skeleton-preview" />
              </div>)}
            </div> : mailboxLoadError && filteredMessages.length === 0 ? (
              <div className="message-list-error" role="alert">
                <strong>{t('mailboxLoadFailed')}</strong>
                <span>{t('mailboxLoadFailedDescription')}</span>
                <Button variant="ghost" type="button" onClick={() => { void refreshMailbox() }}>{t('tryAgain')}</Button>
              </div>
            ) : filteredMessages.length > 0 ? filteredMessages.map((message) => (
              <MailRow key={message.id} message={{ ...message, time: formatMessageTime(message.time, settings, i18n.language) }} selected={selectedMessageId === message.id} unreadLabel={t('unreadMail')} onSelect={selectMessage} onContextMenu={handleMailContextMenu} onKeyDown={handleMailRowKeyDown} />
            )) : (
              <MailListEmptyState icon={emptyListIcon} title={emptyListCopy.title} description={emptyListCopy.description} />
            )}
          </div>
          {visibleNextPageToken ? <Button className="load-more-button" variant="ghost" type="button" disabled={isLoadingMore} onClick={loadNextPage}>{isLoadingMore ? t('loadingMail') : t('loadMoreMail')}</Button> : null}
        </aside>
        <section ref={mainCanvasRef} className="main-canvas" aria-label={selectedMessage ? undefined : t('mainCanvas')} aria-labelledby={selectedMessage ? 'reader-message-subject' : undefined} onScroll={handleReaderScroll}>
          {selectedMessage ? (
            <article className="mail-reader">
              <ReaderToolbar labels={{ toolbarLabel: t('messageToolbar'), archive: activeFolder === 'trash' ? t('restore') : activeFolder === 'spam' ? t('notSpam') : t('archive'), delete: t('delete'), markUnread: t('markUnread'), reply: t('reply'), moreActions: t('moreActions'), backToMailList: t('backToMailList') }} backButtonRef={readerBackButtonRef} disabled={messageActionInFlightId === selectedMessage.id} disabledActions={{ archive: !isActionAvailable(readerArchiveAction), delete: !isActionAvailable(readerDeleteAction), markUnread: !isActionAvailable('mark_unread'), reply: !activeProviderCapabilities?.can_reply }} onBack={closeReader} onArchive={() => activeFolder === 'trash' || activeFolder === 'spam' ? restoreMessage(selectedMessage.id) : requestArchiveMessage(selectedMessage.id)} onDelete={() => requestDeleteMessage(selectedMessage.id)} onMarkUnread={() => markMessageUnread(selectedMessage.id)} onReply={openReply} />
              <header className={`reader-header ${isReaderScrolled ? 'is-compact' : ''}`}>
                <div className="reader-title-row">
                  <h2 id="reader-message-subject">{selectedMessageSubject}</h2>
                  <Button className={`reader-star ${selectedMessage.starred ? 'active' : ''}`} variant="ghost" size="icon" type="button" aria-label={t('starMail')} title={t('starMail')} aria-pressed={selectedMessage.starred} disabled={!isActionAvailable(selectedMessage.starred ? 'unstar' : 'star')} onClick={() => starMessage(selectedMessage.id)}>
                    <IconStar aria-hidden="true" size={18} stroke={1.8} fill={selectedMessage.starred ? 'currentColor' : 'none'} />
                  </Button>
                </div>
                <div className="reader-meta">
                  <SenderAvatar className="reader-avatar" label={selectedMessageSender} imageUrl={selectedMessage.avatar_url} />
                  <div>
                    <strong dir="auto">{selectedMessageSender}</strong>
                    <button className="reader-details-toggle" type="button" aria-expanded={isReaderDetailsOpen} aria-controls="reader-details" onClick={() => setIsReaderDetailsOpen((current) => !current)}>
                      {t(isReaderDetailsOpen ? 'hideDetails' : 'showDetails')}<IconChevronDown aria-hidden="true" size={14} stroke={1.8} />
                    </button>
                    {isReaderDetailsOpen ? <div className="reader-details" id="reader-details">
                      <span><small>{t('from')}</small><span dir="ltr">{selectedMessage.address}</span></span>
                      <span><small>{t('to')}</small><span dir="ltr">{activeAccount?.address ?? ''}</span></span>
                    </div> : null}
                  </div>
                  <time dateTime={selectedMessage.time}>{selectedMessageTime}</time>
                </div>
              </header>
              <div className="reader-body" aria-busy={loadingMessageId === selectedMessage.id}>
                {loadingMessageId === selectedMessage.id ? (
                  <div className="reader-loading" role="status" aria-label={t('loadingMail')}>
                    <Skeleton className="reader-loading-line reader-loading-line-wide" />
                    <Skeleton className="reader-loading-line" />
                    <Skeleton className="reader-loading-line reader-loading-line-short" />
                  </div>
                ) : messageLoadErrorId === selectedMessage.id ? (
                  <div className="reader-error" role="alert"><strong>{t('messageLoadFailed')}</strong><span>{t('messageLoadFailedDescription')}</span><Button variant="ghost" type="button" onClick={() => retryMessageLoad(selectedMessage.id)}>{t('tryAgain')}</Button></div>
                ) : selectedMessage.body_html ? <MailHtml html={selectedMessage.body_html} title={t('mailContent')} fontScale={settings.readerFontScale} onLinkClick={handleReaderLinkClick} /> : selectedMessage.body ? <p className="reader-plain-text" dir="auto">{selectedMessage.body}</p> : <p className="reader-no-content">{t('messageContentUnavailable')}</p>}
                {selectedMessage.attachments?.length ? <section className="reader-attachments" aria-labelledby="reader-attachments-title">
                  <h3 id="reader-attachments-title"><IconPaperclip aria-hidden="true" size={16} stroke={1.8} />{t('attachments')}</h3>
                  <div className="attachment-list">
                    {selectedMessage.attachments.map((attachment) => <Button key={attachment.id} className="attachment-button" variant="ghost" type="button" disabled={downloadingAttachmentId !== null} onClick={() => downloadAttachment(attachment)}>
                      <span className="attachment-name"><IconPaperclip aria-hidden="true" size={15} stroke={1.8} /><span>{attachment.filename}</span></span>
                      <span className="attachment-size">{formatFileSize(attachment.size)}</span>
                      <IconDownload aria-hidden="true" size={15} stroke={1.8} />
                    </Button>)}
                  </div>
                </section> : null}
                {threadMessages.filter((message) => message.id !== selectedMessage.id).length > 0 ? <section className="thread-history" aria-labelledby="thread-history-title">
                  <div className="thread-history-heading"><h3 id="thread-history-title">{t('conversation')}</h3><span>{t('threadMessageCount', { count: threadMessages.length })}</span></div>
                  {threadMessages.filter((message) => message.id !== selectedMessage.id).map((message) => {
                    return <ThreadMessageCard key={message.id} sender={message.sender} address={message.address} avatarUrl={message.avatar_url} time={formatMessageTime(message.time, settings, i18n.language)} dateTime={message.time} recipient={activeAccount?.address ?? ''} attachments={message.attachments ?? []} downloadingAttachmentId={downloadingAttachmentId} unread={message.unread} starred={message.starred} archiveLabel={activeFolder === 'spam' ? t('notSpam') : activeFolder === 'trash' ? t('restore') : t('archive')} body={message.body} bodyHtml={message.body_html} fontScale={settings.readerFontScale} onLinkClick={handleReaderLinkClick} onDownloadAttachment={(attachment) => downloadAttachment(attachment, message.id)} onToggleStar={() => starMessage(message.id)} onToggleRead={() => { if (message.unread) markMessageRead(message.id); else markMessageUnread(message.id) }} onArchive={() => activeFolder === 'spam' || activeFolder === 'trash' ? restoreMessage(message.id) : requestArchiveMessage(message.id)} onDelete={() => requestDeleteMessage(message.id)} disabledActions={{ star: !isActionAvailable(message.starred ? 'unstar' : 'star'), markRead: !isActionAvailable(message.unread ? 'mark_read' : 'mark_unread'), archive: !isActionAvailable(readerArchiveAction), delete: !isActionAvailable(readerDeleteAction), reply: !activeProviderCapabilities?.can_reply }} onReply={() => {
                      setSelectedMessageId(message.id)
                      loadedThreadIdRef.current = message.thread_id ?? null
                      setIsReaderDetailsOpen(false)
                      setIsReplying(true)
                      setReplyDraft('')
                    }} />
                  })}
                </section> : null}
                {isReplying ? <ReplyComposer value={replyDraft} onChange={setReplyDraft} onCancel={cancelReply} onSubmit={submitReply} isSubmitting={isSendingReply} /> : null}
              </div>
            </article>
          ) : isMailboxBusy ? (
            <div className="reader-empty reader-empty-loading" role="status" aria-label={t('loadingMail')}>
              <div className="reader-loading reader-empty-loading-content">
                <Skeleton className="reader-loading-line reader-loading-line-wide" />
                <Skeleton className="reader-loading-line" />
                <Skeleton className="reader-loading-line reader-loading-line-short" />
              </div>
            </div>
          ) : accountLoadError ? (
            <EmptyState icon="error" title={t('accountsLoadFailed')} description={t('accountsLoadFailedDescription')} actionLabel={t('tryAgain')} actionIcon="refresh" onAction={retryAccountLoad} />
          ) : (
            <EmptyState icon={accounts.length === 0 ? 'account' : 'mail'} title={accounts.length === 0 ? t('connectAccount') : t('noMailSelected')} description={accounts.length === 0 ? t('connectAccountDescription') : t('noMailSelectedDescription')} actionLabel={accounts.length === 0 ? t('addAccount') : undefined} actionHasPopup={accounts.length === 0 ? 'dialog' : undefined} onAction={accounts.length === 0 ? () => { setOpenAddAccount(true); setActiveView('settings') } : undefined} />
          )}
        </section>
        {activeView === 'settings' ? <section className="settings-page" aria-labelledby="settings-title"><SettingsPanel settings={settings} onChange={updateSetting} accounts={accounts} providerLogos={providerLogos} defaultAccountId={defaultAccountId} onSetDefault={setDefaultAccount} onRemoveAccount={removeAccount} onStartAuth={startAuth} onError={(error: unknown) => setToastMessage(getDisplayError(error))} onBackToMail={() => { setOpenAddAccount(false); setActiveView('mail'); clearSearch(); window.requestAnimationFrame(() => settingsButtonRef.current?.focus()) }} isAddAccountOpen={openAddAccount} onAddAccountOpenChange={setOpenAddAccount} /></section> : null}
      </section>
       {contextMenu ? <MailContextMenu x={contextMenu.x} y={contextMenu.y} menuLabel={t('mailActions')} disabled={messageActionInFlightId !== null} disabledActions={{ markUnread: !isActionAvailable((selectableMessages.find((message) => message.id === contextMenu.messageId)?.unread ?? false) ? 'mark_read' : 'mark_unread'), star: !isActionAvailable((selectableMessages.find((message) => message.id === contextMenu.messageId)?.starred ?? false) ? 'unstar' : 'star'), spam: !isActionAvailable('spam'), archive: !isActionAvailable(readerArchiveAction), delete: !isActionAvailable(readerDeleteAction) }} showSpam={activeFolder !== 'spam' && activeFolder !== 'trash'} returnFocusElement={contextMenu.returnFocusElement} labels={{ markUnread: (selectableMessages.find((message) => message.id === contextMenu.messageId)?.unread ?? false) ? t('markRead') : t('markUnread'), star: t('starMail'), archive: activeFolder === 'trash' ? t('restore') : activeFolder === 'spam' ? t('notSpam') : t('archive'), delete: t('delete'), reportSpam: t('reportSpam') }} onClose={() => setContextMenu(null)} onMarkUnread={() => { const message = selectableMessages.find((item) => item.id === contextMenu.messageId); if (message?.unread) markMessageReadFromContext(contextMenu.messageId); else markMessageUnread(contextMenu.messageId) }} onStar={() => starMessage(contextMenu.messageId)} onSpam={() => moveMessageToSpam(contextMenu.messageId)} onArchive={() => activeFolder === 'trash' || activeFolder === 'spam' ? restoreMessage(contextMenu.messageId) : requestArchiveMessage(contextMenu.messageId)} onDelete={() => requestDeleteMessage(contextMenu.messageId)} /> : null}
      <Dialog open={pendingArchiveId !== null} title={t('confirmArchiveTitle')} closeLabel={t('closeDialog')} onClose={cancelArchiveMessage}>
        <div className="confirm-dialog-content"><p>{t('confirmArchiveDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" onClick={cancelArchiveMessage}>{t('cancel')}</Button><Button onClick={confirmArchiveMessage}>{t('archive')}</Button></div></div>
      </Dialog>
      <Dialog open={pendingDeleteId !== null} title={t('confirmDeleteTitle')} closeLabel={t('closeDialog')} onClose={cancelDeleteMessage}>
        <div className="confirm-dialog-content"><p>{t('confirmDeleteDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" onClick={cancelDeleteMessage}>{t('cancel')}</Button><Button variant="danger" onClick={() => confirmDeleteMessage()}>{t('delete')}</Button></div></div>
      </Dialog>
      <Dialog open={pendingPermanentDeleteId !== null} title={t('confirmPermanentDeleteTitle')} closeLabel={t('closeDialog')} onClose={cancelPermanentDeleteMessage}>
        <div className="confirm-dialog-content"><p>{t('confirmPermanentDeleteDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" onClick={cancelPermanentDeleteMessage}>{t('cancel')}</Button><Button variant="danger" onClick={() => { if (pendingPermanentDeleteId) permanentlyDeleteMessage(pendingPermanentDeleteId) }}>{t('delete')}</Button></div></div>
      </Dialog>
      <Dialog open={isComposing} title={t('compose')} closeLabel={t('closeDialog')} onClose={closeComposer}>
        <ComposeForm recipient={composeRecipient} cc={composeCc} bcc={composeBcc} subject={composeSubject} body={composeBody} draftStatus={draftStatus} isSending={isSendingMessage} onRecipientChange={updateComposeRecipient} onCcChange={updateComposeCc} onBccChange={updateComposeBcc} onSubjectChange={updateComposeSubject} onBodyChange={updateComposeBody} onCancel={closeComposer} onSubmit={submitMessage} />
      </Dialog>
      <Dialog open={isCloseConfirmationOpen} title={t('confirmCloseTitle')} closeLabel={t('closeDialog')} onClose={() => setIsCloseConfirmationOpen(false)}>
        <div className="confirm-dialog-content"><p>{t('confirmCloseDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" type="button" onClick={() => setIsCloseConfirmationOpen(false)}>{t('cancel')}</Button><Button variant="danger" type="button" onClick={confirmWindowClose}>{t('close')}</Button></div></div>
      </Dialog>
      <Toast open={toastMessage.length > 0}>{toastMessage}</Toast>
    </main>
  )
}

export default App
