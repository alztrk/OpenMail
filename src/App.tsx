import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, type RefObject, type UIEvent, lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { IconAlertTriangle, IconArchive, IconBell, IconChevronDown, IconChevronLeft, IconChevronRight, IconClock, IconDownload, IconFileText, IconInbox, IconLock, IconMail, IconMailPlus, IconMaximize, IconMinus, IconPaperclip, IconPencil, IconRefresh, IconSearch, IconSend, IconSettings, IconStar, IconTrash, IconX, IconRestore } from '@tabler/icons-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'
import openMailWordmark from './assets/openmail-wordmark.svg'
import openMailWordmarkDark from './assets/openmail-wordmark-dark.svg'
import gmailLogo from './assets/providers/gmail.svg'
import outlookLogo from './assets/providers/outlook.svg'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/mail/empty-state'
import { MailRow } from '@/components/mail/mail-row'
import { MailListEmptyState } from '@/components/mail/mail-list-empty-state'
import type { MailSearchResult } from '@/components/mail/mail-search-dialog'
import { SenderAvatar } from '@/components/mail/sender-avatar'
import type { ComposeAttachment } from '@/components/mail/attachment-dropzone'
import type { DraftListItem } from '@/components/mail/drafts-panel'
import type { SavedRecipient } from '@/components/mail/recipient-input'
import { loadSavedRecipients, saveRecipient } from '@/lib/saved-recipients'
import { Toast } from '@/components/ui/toast'
import type { ScheduledMessageSummary } from '@/components/mail/scheduled-messages-panel'
import { Dialog } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { areValidEmailAddresses, splitEmailAddresses } from '@/lib/utils'
import { compareMessageTimes, getMessageIdentity, getMessageTimeValue, getSenderLabel } from '@/lib/mail'
import { sanitizeComposeHtml } from '@/lib/compose-html'
import { formatFileSize } from '@/lib/formatters'
import { aggregateNotificationTargets, consumeNotificationDestination, getNotificationLines, getPollingDelayMs, isQuietHours, NOTIFICATION_ACTION_EVENT, registerNotificationDestination, shouldSendDesktopNotification, type NewMailNotification, type NotificationDestination } from '@/lib/notifications'
import { appendNotificationHistory, type NotificationHistoryEntry } from '@/lib/notification-history'
import { getErrorType, logDebug, logError, logInfo, logPerformance, logWarn } from '@/lib/logger'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { loadSettings, saveSettings, type AppSettings, type Density } from '@/settings'
import './App.css'

const SettingsPanel = lazy(() => import('@/components/settings/settings-panel').then(({ SettingsPanel: panel }) => ({ default: panel })))
const MailSearchDialog = lazy(() => import('@/components/mail/mail-search-dialog').then(({ MailSearchDialog: panel }) => ({ default: panel })))
const ComposeForm = lazy(() => import('@/components/mail/compose-form').then(({ ComposeForm: panel }) => ({ default: panel })))
const DraftsPanel = lazy(() => import('@/components/mail/drafts-panel').then(({ DraftsPanel: panel }) => ({ default: panel })))
const NotificationCenter = lazy(() => import('@/components/mail/notification-center').then(({ NotificationCenter: panel }) => ({ default: panel })))
const ScheduledMessagesPanel = lazy(() => import('@/components/mail/scheduled-messages-panel').then(({ ScheduledMessagesPanel: panel }) => ({ default: panel })))
const MailContextMenu = lazy(() => import('@/components/mail/mail-context-menu').then(({ MailContextMenu: panel }) => ({ default: panel })))
const MailHtml = lazy(() => import('@/components/mail/mail-html').then(({ MailHtml: panel }) => ({ default: panel })))
const ReaderToolbar = lazy(() => import('@/components/mail/reader-toolbar').then(({ ReaderToolbar: panel }) => ({ default: panel })))
const ReplyComposer = lazy(() => import('@/components/mail/reply-composer').then(({ ReplyComposer: panel }) => ({ default: panel })))
const ThreadMessageCard = lazy(() => import('@/components/mail/thread-message-card').then(({ ThreadMessageCard: panel }) => ({ default: panel })))

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'upToDate' | 'unavailable' | 'error'

function useStableCallback<Args extends readonly unknown[], Result>(callback: (...args: Args) => Result) {
  const callbackRef = useRef(callback)
  useLayoutEffect(() => {
    callbackRef.current = callback
  }, [callback])
  return useCallback((...args: Args) => callbackRef.current(...args), [])
}

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

type MessageAction = 'archive' | 'unarchive' | 'trash' | 'untrash' | 'spam' | 'not_spam' | 'delete_forever' | 'mark_read' | 'mark_unread' | 'star' | 'unstar'

type MailFolder = 'inbox' | 'spam' | 'sent' | 'trash' | 'starred'
type MailFilter = 'all' | 'unread' | 'starred' | 'attachments'
type MailNavigationFolder = Exclude<MailFolder, 'starred'>
type MailSort = 'newest' | 'oldest' | 'sender_asc' | 'sender_desc'

const MAIL_NAVIGATION_FOLDERS: MailNavigationFolder[] = ['inbox', 'sent', 'spam', 'trash']

const MAIL_SORT_OPTIONS: MailSort[] = ['newest', 'oldest', 'sender_asc', 'sender_desc']

type MailMessage = {
  id: string
  account_id?: string
  thread_id?: string | null
  message_id_header?: string | null
  sender: string
  address: string
  to?: string[]
  cc?: string[]
  bcc?: string[]
  reply_to?: string[]
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

const GMAIL_ATTACHMENT_LIMIT = 25 * 1024 * 1024
const attachmentLimits = {
  // Gmail's MIME request boundary is exclusive after encoding overhead.
  gmail: { maxFileSize: GMAIL_ATTACHMENT_LIMIT - 1, maxTotalSize: GMAIL_ATTACHMENT_LIMIT - 1 },
  outlook: { maxFileSize: 150 * 1024 * 1024, maxTotalSize: 150 * 1024 * 1024 },
} as const

type MessagePage = {
  messages: MailMessage[]
  next_page_token: string | null
  history_id?: string | null
}

type SyncResult = {
  page: MessagePage
  new_message_count: number
  new_messages: NewMailNotification[]
  removed_message_ids: string[]
}

type BulkMessageActionResult = {
  succeeded_message_ids: string[]
  failed_message_ids: string[]
  error: string | null
}

type MailDraft = {
  id: string
  subject: string
  recipient: string
  cc: string
  bcc: string
  body: string
  bodyHtml: string
  attachments: ComposeAttachment[]
  updatedAt: string
}

type AccountSyncStatus = 'idle' | 'syncing' | 'error'
type NotificationPermissionState = 'unknown' | 'granted' | 'denied' | 'requesting'

type MailShortcutContext = {
  accounts: MailAccount[]
  activeAccountId: string
  activeFolder: MailFolder
  activeProviderCapabilities: ProviderCapabilities | null
  activeView: 'mail' | 'settings'
  displayedMessages: MailMessage[]
  isActionAvailable: (action: MessageAction, accountId?: string) => boolean
  isUnifiedInbox: boolean
  markMessageRead: (messageKey: string) => void
  openComposer: () => Promise<void>
  openReply: () => void
  readerArchiveAction: MessageAction
  refreshMailbox: () => Promise<void>
  requestArchiveMessage: (messageKey: string) => void
  restoreMessage: (messageKey: string) => void
  selectAccount: (accountId: string) => void
  selectReaderMessage: (message: MailMessage) => void
  selectUnifiedInbox: () => void
  selectedMessage: MailMessage | null
  selectedMessageAccount: MailAccount | null
  selectedMessageCapabilities: ProviderCapabilities | null
  selectedMessageKey: string | null
  starMessage: (messageKey: string) => void
}

type UndoableMessageAction = {
  accountId: string
  messageId: string
  action: MessageAction
}

function getNotificationSoundName(settings: AppSettings): string | undefined {
  if (!settings.notificationSound || settings.notificationSoundName === 'none') return 'none'
  return settings.notificationSoundName
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

function formatMessageTime(value: string, settings: AppSettings, locale: string): string {
  const timeValue = getMessageTimeValue(value)
  if (!Number.isFinite(timeValue)) return value
  const date = new Date(timeValue)
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
    account_id: incoming.account_id ?? existing.account_id,
    body: incoming.body || existing.body,
    body_html: incoming.body_html ?? existing.body_html,
    avatar_url: incoming.avatar_url ?? existing.avatar_url,
    attachments: incoming.attachments?.length ? incoming.attachments : existing.attachments,
    hasAttachment: incoming.hasAttachment || existing.hasAttachment,
  }
}

function withAccountId(accountId: string, messages: MailMessage[]): MailMessage[] {
  return messages.map((message) => ({ ...message, account_id: accountId }))
}

function mergeUnifiedAccountMessages(existing: MailMessage[], accountId: string, incoming: MailMessage[]): MailMessage[] {
  const otherAccounts = existing.filter((message) => message.account_id !== accountId)
  const currentAccountMessages = mergeMessageLists(
    existing.filter((message) => message.account_id === accountId),
    withAccountId(accountId, incoming),
  )
  return [...otherAccounts, ...currentAccountMessages].sort((left, right) => compareMessageTimes(left.time, right.time))
}

function mergeMessageLists(existing: MailMessage[], incoming: MailMessage[]): MailMessage[] {
  const existingById = new Map(existing.map((message) => [message.id, message]))
  const incomingIds = new Set(incoming.map((message) => message.id))
  const mergedIncoming = incoming.map((message) => {
    const previousMessage = existingById.get(message.id)
    return previousMessage ? mergeMessageDetails(previousMessage, message) : message
  })
  return [...mergedIncoming, ...existing.filter((message) => !incomingIds.has(message.id))]
}

function removeMessagesForAccount(messages: MailMessage[], accountId: string, removedMessageIds: string[]): MailMessage[] {
  if (removedMessageIds.length === 0) return messages
  const removedIds = new Set(removedMessageIds)
  return messages.filter((message) => (message.account_id ?? accountId) !== accountId || !removedIds.has(message.id))
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
  return result.sort((left, right) => compareMessageTimes(left.message.time, right.message.time))
}

const providerLogos = {
  gmail: gmailLogo,
  outlook: outlookLogo,
} as const

type WindowHeaderProps = {
  onRequestClose: () => void
  onWindowActionError: (error: unknown) => void
  onHideToTray: () => Promise<void>
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

function WindowHeader({ onRequestClose, onWindowActionError, onHideToTray, minimizeToTray, searchQuery, searchDisabled, searchLabel, searchCompactLabel, searchOpen, searchInputRef, onSearchQueryChange, onSearchFocus, onSearchKeyDown, onClearSearch, children }: WindowHeaderProps) {
  const { t } = useTranslation()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isTauriRuntime()) return undefined
    const window = getCurrentWindow()
    let cancelled = false
    const refreshMaximizedState = () => {
      void window.isMaximized().then((maximized) => {
        if (!cancelled) setIsMaximized(maximized)
      }).catch(() => {
        if (!cancelled) setIsMaximized(false)
      })
    }
    refreshMaximizedState()
    let removeResizeListener: (() => void) | undefined
    void window.onResized(() => {
      refreshMaximizedState()
    }).then((removeListener) => {
      if (cancelled) {
        removeListener()
        return
      }
      removeResizeListener = removeListener
    }).catch(() => {
      // The initial state remains usable when resize event registration is unavailable.
    })
    return () => {
      cancelled = true
      removeResizeListener?.()
    }
  }, [])

  const minimize = async () => {
    if (!isTauriRuntime()) return
    const window = getCurrentWindow()
    if (minimizeToTray) {
      await onHideToTray()
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
      <div className="window-drag-region" data-tauri-drag-region="true" onDoubleClick={() => { void toggleMaximize().catch(onWindowActionError) }}>
        <div className="window-brand">
          <img className="window-brand-logo window-brand-logo-light" src={openMailWordmark} alt={t('openMailLogoAlt')} />
          <img className="window-brand-logo window-brand-logo-dark" src={openMailWordmarkDark} alt="" aria-hidden="true" />
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
        <button className="window-control" type="button" aria-label={t('minimize')} title={t('minimize')} disabled={!isTauriRuntime()} onClick={() => { void minimize().catch(onWindowActionError) }}>
          <IconMinus aria-hidden="true" size={16} stroke={1.8} />
        </button>
        <button className="window-control" type="button" aria-label={t(isMaximized ? 'restore' : 'maximize')} title={t(isMaximized ? 'restore' : 'maximize')} disabled={!isTauriRuntime()} onClick={() => { void toggleMaximize().catch(onWindowActionError) }}>
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
  unreadCount: number | undefined
  expanded: boolean
  providerLogos: typeof providerLogos
  tabIndex: 0 | -1
  onSelect: () => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
}

function AccountButton({ account, active, syncStatus, unreadCount, expanded, providerLogos, tabIndex, onSelect, onKeyDown }: AccountButtonProps) {
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
    // The account rail is part of the fixed-height shell, so only viewport resizing can move it.
    window.addEventListener('resize', handlePositionChange)
    return () => {
      window.removeEventListener('resize', handlePositionChange)
    }
  }, [popoverPosition, updatePopoverPosition])

  const syncLabel = syncStatus === 'syncing' ? 'accountSyncing' : syncStatus === 'error' ? 'accountSyncFailed' : 'accountSynced'
  const unreadLabel = unreadCount && unreadCount > 0 ? `, ${t('accountUnreadCount', { count: unreadCount })}` : ''
  const accountLabel = active
    ? `${t(account.provider)}, ${account.address}, ${t('activeAccount')}, ${t(syncLabel)}${unreadLabel}`
    : `${t(account.provider)}, ${account.address}, ${t(syncLabel)}${unreadLabel}`

  return <>
    <button ref={buttonRef} className={`account-button ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}`} data-account-id={account.id} type="button" tabIndex={tabIndex} aria-label={accountLabel} title={expanded ? undefined : accountLabel} aria-current={active ? 'page' : undefined} onClick={() => { hidePopover(); onSelect() }} onKeyDown={onKeyDown} onMouseEnter={expanded ? undefined : updatePopoverPosition} onMouseLeave={hidePopover} onFocus={expanded ? undefined : updatePopoverPosition} onBlur={hidePopover}>
      <span className="account-avatar" aria-hidden="true">
        <img src={providerLogos[account.provider]} alt="" />
      </span>
      {expanded ? <span className="account-button-copy"><strong>{t(account.provider)}</strong><span>{account.address}</span></span> : null}
      {unreadCount && unreadCount > 0 ? <span className="account-unread-count" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span> : null}
      <span className={`account-sync-status ${syncStatus}`} aria-hidden="true" />
    </button>
    {!expanded && popoverPosition ? createPortal(
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
    if (message.startsWith('Google authorization failed:')) return t('gmailAuthFailed')
    if (message === 'OAuth callback timed out') return t('gmailAuthTimedOut')
    if (message.startsWith('Microsoft authorization failed:')) return t('outlookAuthFailed')
    if (message === 'Microsoft OAuth callback timed out') return t('outlookAuthTimedOut')
    if (message.startsWith('AUTH_REQUIRED:')) return t('gmailReauthorizationRequired')
    if (message.includes('not configured in Settings') || message.startsWith('GMAIL_CLIENT_CONFIG: Configure') || message.startsWith('OUTLOOK_CLIENT_CONFIG: Configure')) return t('oauthCredentialsRequired')
    if (message.startsWith('GMAIL_CLIENT_CONFIG:')) return t('gmailClientConfigurationRequired')
    if (message === 'OPENMAIL_OAUTH_CLIENT_ID_REQUIRED' || message === 'OPENMAIL_GMAIL_CLIENT_SECRET_REQUIRED') return t('oauthCredentialsRequired')
    if (message === 'OPENMAIL_OUTLOOK_CLIENT_SECRET_UNSUPPORTED') return t('outlookClientSecretUnsupported')
    if (message.includes('selected Gmail account has no stored refresh token')) return t('gmailReauthorizationRequired')
    if (message.startsWith('GMAIL_PERMISSION_REQUIRED:')) return t('gmailPermissionRequired')
    if (message.startsWith('GMAIL_HISTORY_UNAVAILABLE:')) return t('gmailSyncIncomplete')
    if (message.startsWith('GMAIL_SYNC_INCOMPLETE:')) return t('gmailSyncIncomplete')
    if (message.startsWith('GMAIL_DRAFTS_INCOMPLETE:')) return t('gmailDraftsIncomplete')
    if (message.startsWith('GMAIL_SEND_STATUS_UNKNOWN:')) return t('gmailSendStatusUnknown')
    if (message.startsWith('GMAIL_RATE_LIMITED:')) return t('gmailRateLimited')
    if (message.startsWith('OUTLOOK_REAUTH_REQUIRED:')) return t('outlookReauthorizationRequired')
    if (message.startsWith('OUTLOOK_CLIENT_CONFIG:')) return t('outlookClientConfigurationRequired')
    if (message.startsWith('OUTLOOK_PERMISSION_REQUIRED:')) return t('outlookPermissionRequired')
    if (message.startsWith('OUTLOOK_DELTA_CURSOR_INVALID:')) return t('outlookSyncIncomplete')
    if (message.startsWith('OUTLOOK_SYNC_INCOMPLETE:')) return t('outlookSyncIncomplete')
    if (message.startsWith('OUTLOOK_THREAD_INCOMPLETE:')) return t('outlookThreadIncomplete')
    if (message.startsWith('OUTLOOK_DRAFTS_INCOMPLETE:')) return t('outlookDraftsIncomplete')
    if (message.startsWith('OUTLOOK_DRAFT_ATTACHMENTS_INCOMPLETE:')) return t('outlookDraftAttachmentsIncomplete')
    if (message.startsWith('OUTLOOK_RATE_LIMITED:')) return t('outlookRateLimited')
    if (message.startsWith('OUTLOOK_TEMPORARY_ERROR:')) return t('outlookTemporaryError')
    if (message.startsWith('OUTLOOK_ATTACHMENT_TOO_LARGE:')) return t('outlookAttachmentTooLarge')
    if (message.startsWith('OUTLOOK_ATTACHMENTS_TOO_LARGE_TOTAL:')) return t('outlookAttachmentsTooLargeTotal')
    if (message.startsWith('OUTLOOK_ATTACHMENT_UPLOAD_EXPIRED:')) return t('outlookAttachmentUploadExpired')
    if (message === 'OPENMAIL_SEARCH_QUERY_TOO_SHORT' || message === 'Search query is too short') return t('searchQueryTooShort')
    if (message === 'OPENMAIL_PROVIDER_ACTION_UNSUPPORTED' || message === 'The selected provider does not support this message action') return t('providerActionUnsupported')
    if (message === 'OPENMAIL_DRAFT_SENDER_INVALID' || message === 'The draft sender is invalid') return t('invalidDraftSender')
    if (message === 'OPENMAIL_DRAFT_RECIPIENT_INVALID' || message === 'The draft recipient is invalid') return t('invalidDraftRecipient')
    if (message === 'OPENMAIL_DRAFT_COPY_RECIPIENT_INVALID' || message === 'The draft copy recipient is invalid') return t('invalidDraftCopyRecipient')
    if (message === 'OPENMAIL_REPLY_RECIPIENT_INVALID' || message === 'The reply recipient is invalid') return t('invalidReplyRecipient')
    if (message === 'OPENMAIL_REPLY_SENDER_INVALID' || message === 'The reply sender is invalid') return t('invalidReplySender')
    if (message === 'OPENMAIL_REPLY_COPY_RECIPIENT_INVALID' || message === 'The copy recipient is invalid') return t('invalidReplyCopyRecipient')
    if (message.startsWith('OPENMAIL_MESSAGE_RECIPIENT_INVALID') || message.startsWith('The message recipient is invalid')) return t('invalidMessageRecipient')
    if (message === 'OPENMAIL_MESSAGE_SENDER_INVALID' || message === 'The message sender is invalid') return t('invalidMessageSender')
    if (message === 'OPENMAIL_APP_LOCK_PIN_INVALID') return t('appLockPinInvalid')
    if (message === 'OPENMAIL_BACKUP_PASSWORD_TOO_SHORT') return t('backupPasswordTooShort')
    if (message === 'OPENMAIL_BACKUP_PASSWORD_INVALID') return t('backupPasswordInvalid')
    if (message.startsWith('Backup file') || message.startsWith('Backup contents') || message.startsWith('Backup cache') || message.startsWith('Unsupported backup')) return t('backupInvalid')
    if (message.includes('cache encryption key') || message.includes('local cache')) return t('localDataUnavailable')
    if (message.startsWith('Gmail ') || message.startsWith('Gmail token refresh failed')) return t('gmailRequestFailed')
    if (message.startsWith('Microsoft Graph ') || message.startsWith('Microsoft OAuth')) return t('outlookRequestFailed')
    if (message === 'EMPTY_CONVERSATION') return t('emptyConversation')
    return t('unexpectedError')
  }, [t])
  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [accountSyncStatus, setAccountSyncStatus] = useState<Record<string, AccountSyncStatus>>({})
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(() => isTauriRuntime())
  const [accountLoadError, setAccountLoadError] = useState(false)
  const [activeAccountId, setActiveAccountId] = useState('')
  const [isUnifiedInbox, setIsUnifiedInbox] = useState(false)
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(false)
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
  const [unifiedNextPageTokens, setUnifiedNextPageTokens] = useState<Record<string, string | null>>({})
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const loadMoreRequestIdRef = useRef(0)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set())
  const [bulkActionInFlight, setBulkActionInFlight] = useState(false)
  const [threadMessages, setThreadMessages] = useState<MailMessage[]>([])
  const loadedThreadIdRef = useRef<string | null>(null)
  const mainCanvasRef = useRef<HTMLElement>(null)
  const readerBackButtonRef = useRef<HTMLButtonElement>(null)
  const [isReaderDetailsOpen, setIsReaderDetailsOpen] = useState(false)
  const [isReaderScrolled, setIsReaderScrolled] = useState(false)
  const [loadingMessageId, setLoadingMessageId] = useState<string | null>(null)
  const [messageLoadErrorId, setMessageLoadErrorId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [activeFilter, setActiveFilter] = useState<MailFilter>('all')
  const [mailSort, setMailSort] = useState<MailSort>('newest')
  const [activeView, setActiveView] = useState<'mail' | 'settings'>('mail')
  const [openAddAccount, setOpenAddAccount] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ messageId: string; x: number; y: number; returnFocusElement: HTMLButtonElement } | null>(null)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>('unknown')
  const [notificationHistory, setNotificationHistory] = useState<NotificationHistoryEntry[]>([])
  const [isNotificationCenterOpen, setIsNotificationCenterOpen] = useState(false)
  const [isAccountSwitcherOpen, setIsAccountSwitcherOpen] = useState(false)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [appLockConfigured, setAppLockConfigured] = useState(false)
  const [isAppLocked, setIsAppLocked] = useState(false)
  const [appLockPin, setAppLockPin] = useState('')
  const [undoableMessageAction, setUndoableMessageAction] = useState<UndoableMessageAction | null>(null)
  const [defaultAccountId, setDefaultAccountId] = useState('')
  const [toastMessage, setToastMessage] = useState('')
  const [appVersion, setAppVersion] = useState('unknown')
  const [updateState, setUpdateState] = useState<UpdateState>('idle')
  const [updateAvailableVersion, setUpdateAvailableVersion] = useState<string | null>(null)
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)
  const pendingUpdateRef = useRef<Update | null>(null)
  const handleWindowActionError = useCallback((error: unknown) => {
    setToastMessage(getDisplayError(error))
  }, [getDisplayError, setToastMessage])
  const hideToTray = useCallback(async () => {
    if (!isTauriRuntime()) return
    await invoke('hide_main_window')
  }, [])
  const restoreWindow = useCallback(async () => {
    if (!isTauriRuntime()) return
    const window = getCurrentWindow()
    await window.show()
    await window.unminimize()
    await window.setFocus()
  }, [])
  const requestNotificationPermission = useCallback(async (): Promise<boolean> => {
    if (!isTauriRuntime()) return false
    setNotificationPermission('requesting')
    try {
      const permission = await requestPermission()
      const granted = permission === 'granted'
      setNotificationPermission(granted ? 'granted' : 'denied')
      if (!granted) setToastMessage(t('notificationPermissionDenied'))
      return granted
    } catch {
      setNotificationPermission('denied')
      setToastMessage(t('notificationPermissionFailed'))
      return false
    }
  }, [t])
  const checkForUpdates = useCallback(async (options: { silent?: boolean } = {}): Promise<void> => {
    if (!isTauriRuntime()) {
      setUpdateState('unavailable')
      return
    }
    setUpdateState('checking')
    setUpdateProgress(null)
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      pendingUpdateRef.current = update
      if (!update) {
        setUpdateAvailableVersion(null)
        setUpdateState('upToDate')
        if (!options.silent) setToastMessage(t('updateAlreadyLatest'))
        return
      }
      setUpdateAvailableVersion(update.version)
      setUpdateState('available')
      if (options.silent) setToastMessage(t('updateAvailable', { version: update.version }))
    } catch {
      pendingUpdateRef.current = null
      setUpdateAvailableVersion(null)
      setUpdateState('error')
      if (!options.silent) setToastMessage(t('updateCheckFailed'))
    }
  }, [t])
  const installUpdate = useCallback(async (): Promise<void> => {
    const update = pendingUpdateRef.current
    if (!update || updateState !== 'available') return
    if (!window.confirm(t('updateInstallConfirm', { version: update.version }))) return
    setUpdateState('downloading')
    setUpdateProgress(0)
    let downloadedBytes = 0
    let contentLength: number | undefined
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength
          return
        }
        if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength
          if (contentLength && contentLength > 0) setUpdateProgress(Math.min(100, Math.round((downloadedBytes / contentLength) * 100)))
        }
      })
      setUpdateState('ready')
      setUpdateProgress(100)
      pendingUpdateRef.current = null
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch {
      setUpdateState('error')
      setUpdateProgress(null)
      setToastMessage(t('updateInstallFailed'))
    }
  }, [t, updateState])
  useEffect(() => {
    if (!isTauriRuntime()) return
    void getVersion().then(setAppVersion).catch(() => setAppVersion('unknown'))
    const timeoutId = window.setTimeout(() => { void checkForUpdates({ silent: true }) }, 4000)
    return () => window.clearTimeout(timeoutId)
  }, [checkForUpdates])
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
  const [composeBodyHtml, setComposeBodyHtml] = useState('')
  const [composeScheduleAt, setComposeScheduleAt] = useState('')
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([])
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [composeAccountId, setComposeAccountId] = useState<string | null>(null)
  const [composeDraftId, setComposeDraftId] = useState<string | null>(null)
  const [composeDrafts, setComposeDrafts] = useState<DraftListItem[]>([])
  const [isDraftsPanelOpen, setIsDraftsPanelOpen] = useState(false)
  const [isScheduledMessagesPanelOpen, setIsScheduledMessagesPanelOpen] = useState(false)
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessageSummary[]>([])
  const [isLoadingDrafts, setIsLoadingDrafts] = useState(false)
  const [savedRecipients, setSavedRecipients] = useState<SavedRecipient[]>(loadSavedRecipients)
  const [isSendingMessage, setIsSendingMessage] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isAccountMutationInFlight, setIsAccountMutationInFlight] = useState(false)
  const [messageActionInFlightId, setMessageActionInFlightId] = useState<string | null>(null)
  const [providerCapabilitiesByAccount, setProviderCapabilitiesByAccount] = useState<Record<string, ProviderCapabilities>>({})
  const settingsRef = useRef(settings)
  const launchAtStartupRequestIdRef = useRef(0)
  const accountMutationInFlightRef = useRef(false)
  const accountsLoadRequestIdRef = useRef(0)
  const syncInFlightAccountsRef = useRef(new Set<string>())
  const pendingNotificationDestinationRef = useRef<NotificationDestination | null>(null)
  const composeRevisionRef = useRef(0)
  const draftListRequestIdRef = useRef(0)
  const draftLoadRequestIdRef = useRef(0)
  const draftSaveInFlightRef = useRef(false)
  const pendingWindowCloseAfterComposeRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const mailShortcutContextRef = useRef<MailShortcutContext | null>(null)
  const suppressSearchFocusRef = useRef(false)
  const searchRequestIdRef = useRef(0)
  const searchLoadRequestIdRef = useRef(0)
  const searchLoadMoreRequestKeyRef = useRef<string | null>(null)
  const allowWindowCloseRef = useRef(false)
  const [isCloseConfirmationOpen, setIsCloseConfirmationOpen] = useState(false)
  const [isComposeCloseConfirmationOpen, setIsComposeCloseConfirmationOpen] = useState(false)
  const activeAccountIdRef = useRef(activeAccountId)
  const activeFolderRef = useRef(activeFolder)
  const isUnifiedInboxRef = useRef(isUnifiedInbox)
  const messageListRef = useRef<HTMLDivElement>(null)
  const loadMoreSentinelRef = useRef<HTMLSpanElement>(null)
  const loadMoreRequestKeyRef = useRef<string | null>(null)
  const autoPagingBlockedRef = useRef(false)
  const searchAutoPagingBlockedRef = useRef(false)
  useEffect(() => {
    activeAccountIdRef.current = activeAccountId
    activeFolderRef.current = activeFolder
    isUnifiedInboxRef.current = isUnifiedInbox
  }, [activeAccountId, activeFolder, isUnifiedInbox])
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void isPermissionGranted()
      .then((granted) => {
        if (!cancelled) setNotificationPermission(granted ? 'granted' : 'denied')
      })
      .catch(() => {
        if (!cancelled) setNotificationPermission('unknown')
      })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!isTauriRuntime()) return
    void invoke<boolean>('get_app_lock_status').then((configured) => {
      setAppLockConfigured(configured)
      if (configured) setIsAppLocked(true)
    }).catch((error: unknown) => setToastMessage(getDisplayError(error)))
  }, [getDisplayError])
  const activeProviderCapabilities = providerCapabilitiesByAccount[activeAccountId] ?? null
  const composeOpenSequenceRef = useRef(0)

  const hasUnsavedComposeContent = useCallback(() => {
    if (!isComposing || draftStatus !== 'idle') return false
    return [composeRecipient, composeCc, composeBcc, composeSubject, composeBody].some((value) => value.trim().length > 0) || composeAttachments.length > 0
  }, [composeAttachments.length, composeBcc, composeBody, composeCc, composeRecipient, composeSubject, draftStatus, isComposing])

  const markComposeDirty = () => {
    composeRevisionRef.current += 1
    if (!draftSaveInFlightRef.current) setDraftStatus('idle')
  }
  const updateComposeRecipient = (value: string) => { setComposeRecipient(value); markComposeDirty() }
  const updateComposeCc = (value: string) => { setComposeCc(value); markComposeDirty() }
  const updateComposeBcc = (value: string) => { setComposeBcc(value); markComposeDirty() }
  const updateComposeSubject = (value: string) => { setComposeSubject(value); markComposeDirty() }
  const updateComposeBody = (value: string) => { setComposeBody(value); markComposeDirty() }
  const updateComposeBodyHtml = (value: string) => { setComposeBodyHtml(value); markComposeDirty() }
  const updateComposeAttachments = (attachments: ComposeAttachment[]) => { setComposeAttachments(attachments); markComposeDirty() }

  const selectableMessages = useMemo(
    () => activeView === 'mail'
      ? activeFolder !== 'inbox' ? folderMessages : (isUnifiedInbox || messagesAccountId === activeAccountId) ? messages : []
      : [],
    [activeAccountId, activeFolder, activeView, folderMessages, isUnifiedInbox, messages, messagesAccountId],
  )
  const filteredMessages = useMemo(
    () => selectableMessages.filter((message) => {
      return activeFilter === 'all'
        || (activeFilter === 'unread' && message.unread)
        || (activeFilter === 'starred' && message.starred)
        || (activeFilter === 'attachments' && message.hasAttachment)
    }),
    [activeFilter, selectableMessages],
  )
  const displayedMessages = useMemo(() => {
    const sorted = [...filteredMessages]
    if (mailSort === 'newest') return sorted.sort((left, right) => compareMessageTimes(left.time, right.time))
    if (mailSort === 'oldest') return sorted.sort((left, right) => compareMessageTimes(right.time, left.time))
    return sorted.sort((left, right) => {
      const senderOrder = getSenderLabel(left.sender, left.address).localeCompare(getSenderLabel(right.sender, right.address), i18n.language, { sensitivity: 'base' })
      return mailSort === 'sender_asc' ? senderOrder : -senderOrder
    })
  }, [filteredMessages, i18n.language, mailSort])
  const accountLabelsById = useMemo(() => new Map(accounts.map((account) => [account.id, account.address])), [accounts])
  const displayedMessageRows = useMemo(
    () => displayedMessages.map((message) => ({
      ...message,
      messageKey: getMessageIdentity(message, activeAccountId),
      accountLabel: isUnifiedInbox ? accountLabelsById.get(message.account_id ?? '') : undefined,
      time: formatMessageTime(message.time, settings, i18n.language),
    })),
    [accountLabelsById, activeAccountId, displayedMessages, i18n.language, isUnifiedInbox, settings],
  )

  useEffect(() => {
    if (!isTauriRuntime() || activeView !== 'mail' || displayedMessageRows.length === 0) return undefined
    const startedAt = performance.now()
    const frameId = window.requestAnimationFrame(() => {
      logPerformance('mailbox.render.first_frame', performance.now() - startedAt, {
        active_folder: activeFolder,
        message_count: displayedMessageRows.length,
        reader_open: selectedMessageId !== null,
      })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [activeFolder, activeView, displayedMessageRows.length, selectedMessageId])

  const selectedVisibleMessageCount = useMemo(
    () => filteredMessages.filter((message) => selectedMessageIds.has(getMessageIdentity(message, activeAccountId))).length,
    [activeAccountId, filteredMessages, selectedMessageIds],
  )
  const allVisibleMessagesSelected = filteredMessages.length > 0 && filteredMessages.every((message) => selectedMessageIds.has(getMessageIdentity(message, activeAccountId)))
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

  const clearBulkSelection = useCallback(() => setSelectedMessageIds(new Set()), [])
  const invalidateLoadMore = useCallback(() => {
    loadMoreRequestIdRef.current += 1
    loadMoreRequestKeyRef.current = null
    autoPagingBlockedRef.current = false
    setIsLoadingMore(false)
  }, [])
  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds((current) => {
      const next = new Set(current)
      if (next.has(messageId)) next.delete(messageId)
      else next.add(messageId)
      return next
    })
  }, [])
  const toggleAllMessageSelection = useCallback(() => {
    const filteredMessageIds = filteredMessages.map((message) => getMessageIdentity(message, activeAccountId))
    setSelectedMessageIds((current) => {
      const allVisibleMessagesSelected = filteredMessageIds.length > 0 && filteredMessageIds.every((messageId) => current.has(messageId))
      return allVisibleMessagesSelected ? new Set() : new Set(filteredMessageIds)
    })
  }, [activeAccountId, filteredMessages])

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
    searchLoadRequestIdRef.current += 1
    searchLoadMoreRequestKeyRef.current = null
    searchAutoPagingBlockedRef.current = false
    setSearchQuery('')
    setSearchResults([])
    setSearchPageTokens({})
    setIsLoadingMoreSearch(false)
    setIsSearchOpen(false)
    setIsSearchingMail(false)
    setSearchError(false)
    setSearchPartialError(false)
    setSearchActiveIndex(0)
  }, [])

  const navigateToSettings = useCallback((openAccountDialog = false) => {
    invalidateLoadMore()
    setOpenAddAccount(openAccountDialog)
    setActiveView('settings')
    setContextMenu(null)
    clearSearch()
  }, [clearSearch, invalidateLoadMore])

  const toggleSettings = useCallback(() => {
    if (activeView === 'settings') {
      invalidateLoadMore()
      setOpenAddAccount(false)
      setActiveView('mail')
      setContextMenu(null)
      clearSearch()
      return
    }
    navigateToSettings()
  }, [activeView, clearSearch, invalidateLoadMore, navigateToSettings])

  useEffect(() => {
    selectableMessagesRef.current = selectableMessages
  }, [selectableMessages])

  const loadAccounts = useCallback(() => {
    if (!isTauriRuntime()) return
    const requestId = ++accountsLoadRequestIdRef.current
    const startedAt = performance.now()
    logDebug('accounts.load.start', { request_id: requestId })
    void invoke<MailAccount[]>('list_accounts').then((loadedAccounts) => {
      if (requestId !== accountsLoadRequestIdRef.current) return
      logInfo('accounts.load.complete', {
        account_count: loadedAccounts.length,
        has_default_account: loadedAccounts.some((account) => account.is_default),
      })
      logPerformance('accounts.load', performance.now() - startedAt, { account_count: loadedAccounts.length })
      setAccounts(loadedAccounts)
      setIsLoadingAccounts(false)
      setAccountLoadError(false)
      const defaultAccount = loadedAccounts.find((account) => account.is_default) ?? loadedAccounts[0]
      if (!defaultAccount) {
        setProviderCapabilitiesByAccount({})
        setAccountSyncStatus({})
        clearBulkSelection()
        setIsUnifiedInbox(false)
        setActiveAccountId('')
        setDefaultAccountId('')
        setIsLoadingMessages(false)
        setMessages([])
        setMessagesAccountId(null)
        setNextPageToken(null)
        setUnifiedNextPageTokens({})
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
    }).catch((error: unknown) => {
      if (requestId !== accountsLoadRequestIdRef.current) return
      logError('accounts.load.failed', { error_type: getErrorType(error) })
      logPerformance('accounts.load.failed', performance.now() - startedAt)
      setAccounts([])
      setProviderCapabilitiesByAccount({})
      setAccountSyncStatus({})
      setIsLoadingAccounts(false)
      setAccountLoadError(true)
      setIsUnifiedInbox(false)
      setIsLoadingMessages(false)
      setActiveAccountId('')
      setDefaultAccountId('')
      setMessages([])
      setMessagesAccountId(null)
      setNextPageToken(null)
      setUnifiedNextPageTokens({})
      setFolderMessages([])
      setFolderNextPageToken(null)
      setIsLoadingFolder(false)
      setActiveFolder('inbox')
      setActiveFilter('all')
      clearSearch()
      clearReaderSelection()
      clearBulkSelection()
      setContextMenu(null)
    })
  }, [clearBulkSelection, clearReaderSelection, clearSearch, setActiveFilter, setActiveFolder, setActiveAccountId, setAccountLoadError, setContextMenu, setDefaultAccountId, setFolderMessages, setFolderNextPageToken, setIsLoadingAccounts, setIsLoadingFolder, setIsLoadingMessages, setMessages, setMessagesAccountId, setNextPageToken, setAccounts])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  const retryAccountLoad = () => {
    setIsLoadingAccounts(true)
    setAccountLoadError(false)
    loadAccounts()
  }

  useEffect(() => {
    if (!isTauriRuntime() || accounts.length === 0) return
    let cancelled = false
    const startedAt = performance.now()
    logDebug('provider.capabilities.load.start', { account_count: accounts.length })
    void Promise.allSettled(accounts.map((account) => invoke<ProviderCapabilities>('get_provider_capabilities', { accountId: account.id })))
      .then((results) => {
        if (cancelled) return
        const nextCapabilities: Record<string, ProviderCapabilities> = {}
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') nextCapabilities[accounts[index].id] = result.value
        })
        setProviderCapabilitiesByAccount(nextCapabilities)
        logInfo('provider.capabilities.load.complete', {
          account_count: accounts.length,
          success_count: Object.keys(nextCapabilities).length,
        })
        logPerformance('provider.capabilities.load', performance.now() - startedAt, { account_count: accounts.length })
        const activeFailure = results.find((result, index) => result.status === 'rejected' && accounts[index].id === activeAccountId)
        if (activeFailure?.status === 'rejected') {
          logWarn('provider.capabilities.load.partial_failure', { error_type: getErrorType(activeFailure.reason) })
          setToastMessage(getDisplayError(activeFailure.reason))
        }
      })
    return () => { cancelled = true }
  }, [accounts, activeAccountId, getDisplayError])

  useEffect(() => {
    if (!isTauriRuntime()) return
    if (!activeAccountId || activeView !== 'mail') {
      return
    }
    let cancelled = false
    let networkSyncCompleted = false
    const startedAt = performance.now()
    logDebug('mailbox.load.start', {
      unified: isUnifiedInbox,
      account_count: isUnifiedInbox ? accounts.length : 1,
    })

    if (isUnifiedInbox) {
      void Promise.allSettled(accounts.map((account) => invoke<MessagePage | null>('get_cached_messages', { accountId: account.id })))
        .then((results) => {
          if (cancelled || networkSyncCompleted) return
          setUnifiedNextPageTokens(Object.fromEntries(accounts.map((account, index) => {
            const result = results[index]
            return [account.id, result?.status === 'fulfilled' ? result.value?.next_page_token ?? null : null]
          })))
          const cachedMessages = results.flatMap((result, index) => result.status === 'fulfilled' && result.value
            ? withAccountId(accounts[index].id, result.value.messages)
            : [])
          const hasCachedPage = results.some((result) => result.status === 'fulfilled' && result.value !== null)
          logDebug('mailbox.cache.load.complete', {
            unified: true,
            account_count: accounts.length,
            message_count: cachedMessages.length,
            hit_count: results.filter((result) => result.status === 'fulfilled' && result.value !== null).length,
          })
          if (cachedMessages.length > 0) setMessages(cachedMessages.sort((left, right) => compareMessageTimes(left.time, right.time)))
          if (hasCachedPage) {
            setMessagesAccountId(null)
            setIsLoadingMessages(false)
            setMailboxLoadError(false)
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setToastMessage(getDisplayError(error))
        })

      const accountsToSync = accounts.filter((account) => !syncInFlightAccountsRef.current.has(account.id))
      if (accountsToSync.length === 0) return () => { cancelled = true }
      accountsToSync.forEach((account) => syncInFlightAccountsRef.current.add(account.id))
      setAccountSyncStatus((current) => accountsToSync.reduce((next, account) => ({ ...next, [account.id]: 'syncing' as const }), current))
      void Promise.allSettled(accountsToSync.map((account) => invoke<SyncResult>('sync_messages', { accountId: account.id })))
        .then((results) => {
          if (cancelled) return
          let successCount = 0
          results.forEach((result, index) => {
            const accountId = accountsToSync[index].id
            if (result.status === 'rejected') {
              setAccountSyncStatus((current) => ({ ...current, [accountId]: 'error' }))
              return
            }
            successCount += 1
            setAccountSyncStatus((current) => ({ ...current, [accountId]: 'idle' }))
            setUnifiedNextPageTokens((current) => ({ ...current, [accountId]: result.value.page.next_page_token }))
            setMessages((current) => mergeUnifiedAccountMessages(
              removeMessagesForAccount(current, accountId, result.value.removed_message_ids),
              accountId,
              result.value.page.messages,
            ))
          })
          networkSyncCompleted = successCount > 0
          logInfo('mailbox.load.complete', {
            unified: true,
            account_count: accountsToSync.length,
            success_count: successCount,
            message_count: results.reduce((count, result) => result.status === 'fulfilled' ? count + result.value.page.messages.length : count, 0),
          })
          logPerformance('mailbox.load', performance.now() - startedAt, { unified: true })
          if (successCount > 0) {
            setMailboxLoadError(false)
            setIsLoadingMessages(false)
          } else {
            setMailboxLoadError(true)
            const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
            if (firstFailure) {
              logError('mailbox.load.failed', { unified: true, error_type: getErrorType(firstFailure.reason) })
              setToastMessage(getDisplayError(firstFailure.reason))
            }
          }
        })
        .finally(() => {
          accountsToSync.forEach((account) => syncInFlightAccountsRef.current.delete(account.id))
          if (!cancelled && networkSyncCompleted) setIsLoadingMessages(false)
        })
      return () => { cancelled = true }
    }

    void invoke<MessagePage | null>('get_cached_messages', { accountId: activeAccountId })
      .then((cachedPage) => {
        if (cancelled || networkSyncCompleted || !cachedPage) return
        logDebug('mailbox.cache.load.complete', { unified: false, hit_count: 1, message_count: cachedPage.messages.length })
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
    const requestedAccountId = activeAccountId
    const shouldStartSync = !syncInFlightAccountsRef.current.has(requestedAccountId)
    if (!shouldStartSync) return () => { cancelled = true }
    syncInFlightAccountsRef.current.add(requestedAccountId)
    void invoke<SyncResult>('sync_messages', { accountId: requestedAccountId })
      .then((result) => {
        if (cancelled) return
        networkSyncCompleted = true
        logInfo('mailbox.load.complete', {
          unified: false,
          account_count: 1,
          message_count: result.page.messages.length,
          new_message_count: result.new_message_count,
        })
        logPerformance('mailbox.load', performance.now() - startedAt, { unified: false })
        setAccountSyncStatus((current) => ({ ...current, [requestedAccountId]: 'idle' }))
        setMessages((current) => mergeMessageLists(
          removeMessagesForAccount(current, requestedAccountId, result.removed_message_ids),
          withAccountId(requestedAccountId, result.page.messages),
        ))
        setNextPageToken(result.page.next_page_token)
        setMessagesAccountId(requestedAccountId)
        setMailboxLoadError(false)
      })
      .catch((error: unknown) => {
        setAccountSyncStatus((current) => ({ ...current, [requestedAccountId]: 'error' }))
        logError('mailbox.load.failed', { unified: false, error_type: getErrorType(error) })
        logPerformance('mailbox.load.failed', performance.now() - startedAt, { unified: false })
        if (!cancelled) {
          setMailboxLoadError(true)
          setToastMessage(getDisplayError(error))
        }
      })
      .finally(() => {
        syncInFlightAccountsRef.current.delete(requestedAccountId)
        if (!cancelled) setIsLoadingMessages(false)
      })
    return () => { cancelled = true }
  }, [accounts, activeAccountId, activeView, getDisplayError, isUnifiedInbox])

  useEffect(() => {
    if (accounts.length === 0) return
    let cancelled = false
    let nativeWindowFocused = true
    let consecutiveFailures = 0
    let lastSyncError = ''
    let timeoutId: number | undefined
    const isForeground = () => document.visibilityState === 'visible' && nativeWindowFocused
    const scheduleNextSync = () => {
      if (cancelled) return
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(sync, getPollingDelayMs(isForeground(), consecutiveFailures))
    }
    const sync = () => {
      if (cancelled) return
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
        timeoutId = undefined
      }
      const accountsToSync = accounts.filter((account) => !syncInFlightAccountsRef.current.has(account.id))
      if (accountsToSync.length === 0) {
        scheduleNextSync()
        return
      }
      const startedAt = performance.now()
      logDebug('sync.poll.start', { account_count: accountsToSync.length, foreground: isForeground() })
      accountsToSync.forEach((account) => syncInFlightAccountsRef.current.add(account.id))
      setAccountSyncStatus((current) => accountsToSync.reduce((next, account) => ({ ...next, [account.id]: 'syncing' as const }), current))
      void Promise.allSettled(accountsToSync.map((account) => invoke<SyncResult>('sync_messages', { accountId: account.id })))
        .then(async (results) => {
          if (cancelled) return
          const notificationTargets: Array<{ accountId: string; newMessageCount: number; messages: NewMailNotification[] }> = []
          let failedAccountCount = 0
          let firstFailure: unknown = null
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              failedAccountCount += 1
              firstFailure ??= result.reason
              setAccountSyncStatus((current) => ({ ...current, [accountsToSync[index].id]: 'error' }))
              return
            }
            setAccountSyncStatus((current) => ({ ...current, [accountsToSync[index].id]: 'idle' }))
            if (result.value.new_message_count > 0) notificationTargets.push({ accountId: accountsToSync[index].id, newMessageCount: result.value.new_message_count, messages: result.value.new_messages })
            if (!cancelled && isUnifiedInbox && activeFolder === 'inbox') {
              setUnifiedNextPageTokens((current) => ({ ...current, [accountsToSync[index].id]: result.value.page.next_page_token }))
              setMessages((current) => mergeUnifiedAccountMessages(
                removeMessagesForAccount(current, accountsToSync[index].id, result.value.removed_message_ids),
                accountsToSync[index].id,
                result.value.page.messages,
              ))
              setMessagesAccountId(null)
              setIsLoadingMessages(false)
              setMailboxLoadError(false)
            } else if (!cancelled && accountsToSync[index].id === activeAccountId) {
              setMessages((current) => mergeMessageLists(
                removeMessagesForAccount(current, accountsToSync[index].id, result.value.removed_message_ids),
                withAccountId(accountsToSync[index].id, result.value.page.messages),
              ))
              setNextPageToken(result.value.page.next_page_token)
              setMessagesAccountId(activeAccountId)
              setIsLoadingMessages(false)
              setMailboxLoadError(false)
            }
          })
          if (failedAccountCount > 0) {
            consecutiveFailures += 1
            const errorMessage = firstFailure ? getDisplayError(firstFailure) : t('unexpectedError')
            if (errorMessage !== lastSyncError || consecutiveFailures === 1) setToastMessage(errorMessage)
            lastSyncError = errorMessage
          } else {
            consecutiveFailures = 0
            lastSyncError = ''
          }
          logInfo('sync.poll.complete', {
            account_count: accountsToSync.length,
            failed_account_count: failedAccountCount,
            notification_target_count: notificationTargets.length,
            consecutive_failures: consecutiveFailures,
          })
          logPerformance('sync.poll', performance.now() - startedAt, { account_count: accountsToSync.length })
          if (cancelled || notificationTargets.length === 0) return
          const quietHoursActive = isQuietHours(settings)
          const notificationsSuppressed = !settings.notificationsEnabled
            ? 'disabled'
            : quietHoursActive
              ? 'quiet_hours'
              : !shouldSendDesktopNotification(document.visibilityState === 'visible', nativeWindowFocused)
                ? 'window_focused'
                : null
          if (notificationsSuppressed) {
            logInfo('notification.suppressed', {
              account_count: notificationTargets.length,
              message_count: notificationTargets.reduce((count, target) => count + target.newMessageCount, 0),
              reason: notificationsSuppressed,
            })
            return
          }
          const permissionGranted = await isPermissionGranted()
          if (cancelled) return
          setNotificationPermission(permissionGranted ? 'granted' : 'denied')
          if (!permissionGranted) {
            logInfo('notification.suppressed', {
              account_count: notificationTargets.length,
              message_count: notificationTargets.reduce((count, target) => count + target.newMessageCount, 0),
              reason: 'permission_denied',
            })
            return
          }
          const batch = aggregateNotificationTargets(notificationTargets)
          if (batch.count <= 0) return
          const firstMessage = batch.messages[0]
          const singleMessage = batch.count === 1 && firstMessage
          const notificationKey = firstMessage
            ? registerNotificationDestination({
              accountId: firstMessage.accountId,
              messageId: firstMessage.id,
              threadId: firstMessage.thread_id,
            })
            : null
          const lines = getNotificationLines(batch)
          const notificationOptions = {
            title: singleMessage ? firstMessage.sender || t('newMailNotificationTitle') : t('newMailNotificationTitle'),
            body: singleMessage ? firstMessage.subject || t('newMailNotificationBody', { count: batch.count }) : t('newMailNotificationBody', { count: batch.count }),
            sound: getNotificationSoundName(settings),
            actionLabel: t('openMailNotification'),
            notificationKey,
            inboxLines: !singleMessage ? lines : [],
          }
          try {
            await invoke('send_desktop_notification', { request: notificationOptions })
            logInfo('notification.send.complete', { message_count: batch.count, account_count: batch.accountIds.length })
            setNotificationHistory((current) => appendNotificationHistory(current, {
              id: notificationKey ?? `${Date.now()}-${batch.count}`,
              title: notificationOptions.title,
              body: notificationOptions.body,
              createdAt: Date.now(),
              destination: firstMessage ? {
                accountId: firstMessage.accountId,
                messageId: firstMessage.id,
                threadId: firstMessage.thread_id,
              } : null,
            }))
          } catch (error: unknown) {
            logError('notification.send.failed', { error_type: getErrorType(error), message_count: batch.count })
            if (!cancelled) setToastMessage(t('notificationSendFailed'))
          }
        })
        .catch((error: unknown) => {
          logError('sync.poll.failed', { error_type: getErrorType(error) })
          logPerformance('sync.poll.failed', performance.now() - startedAt)
          if (!cancelled) setToastMessage(getDisplayError(error))
        })
        .finally(() => {
          accountsToSync.forEach((account) => syncInFlightAccountsRef.current.delete(account.id))
          scheduleNextSync()
        })
    }
    const handleWindowFocus = () => {
      nativeWindowFocused = true
      sync()
    }
    let removeTauriFocusListener: (() => void) | undefined
    if (isTauriRuntime()) {
      void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        nativeWindowFocused = focused
        if (!cancelled && focused) sync()
        else scheduleNextSync()
      }).then((removeListener) => {
        if (cancelled) {
          removeListener()
          return
        }
        removeTauriFocusListener = removeListener
      }).catch((error: unknown) => {
        if (!cancelled) setToastMessage(getDisplayError(error))
      })
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') sync()
      else scheduleNextSync()
    }
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    scheduleNextSync()
    return () => {
      cancelled = true
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      removeTauriFocusListener?.()
    }
  }, [accounts, activeAccountId, activeFolder, activeView, getDisplayError, isUnifiedInbox, settings, t])

  useEffect(() => {
    const query = deferredSearchQuery.trim()
    const requestId = searchRequestIdRef.current + 1
    searchRequestIdRef.current = requestId
    if (!isTauriRuntime() || accounts.length === 0 || query.length < 2) return
    let cancelled = false
    const search = () => {
      const startedAt = performance.now()
      logDebug('search.load.start', { account_count: accounts.length, query_length: query.length })
      // Start local and network lookups together and publish each result as soon as it arrives.
      const cachedResponsesPromise = Promise.allSettled(accounts.map((account) => invoke<MessagePage>('search_cached_messages', { accountId: account.id, query })))
      const remoteResponsesPromise = Promise.allSettled(accounts.map((account) => invoke<MessagePage>('search_messages', { accountId: account.id, query })))
      let cachedResults: MailSearchResult[] = []
      let remoteResults: MailSearchResult[] = []
      let remoteCompleted = false
      let successfulAccountCount = 0
      let failedAccountCount = 0
      const publishResults = () => {
        if (cancelled || requestId !== searchRequestIdRef.current) return
        setSearchResults(mergeSearchResults(cachedResults, remoteResults))
        if (!remoteCompleted) return
        setIsSearchingMail(false)
        setSearchError(successfulAccountCount === 0 && cachedResults.length === 0)
        setSearchPartialError(failedAccountCount > 0 && (successfulAccountCount > 0 || cachedResults.length > 0))
      }

      void cachedResponsesPromise.then((responses) => {
        if (cancelled || requestId !== searchRequestIdRef.current) return
        cachedResults = responses.flatMap((response, index) => response.status === 'fulfilled' && response.value
          ? response.value.messages.map((message) => ({ account: accounts[index], message }))
          : [])
        logDebug('search.cache.load.complete', {
          account_count: accounts.length,
          result_count: cachedResults.length,
          hit_count: responses.filter((response) => response.status === 'fulfilled' && response.value !== null).length,
        })
        publishResults()
      })
      void remoteResponsesPromise.then((responses) => {
        if (cancelled || requestId !== searchRequestIdRef.current) return
        remoteResults = responses.flatMap((response, index) => response.status === 'fulfilled'
          ? response.value.messages.map((message) => ({ account: accounts[index], message }))
          : [])
        successfulAccountCount = responses.filter((response) => response.status === 'fulfilled').length
        failedAccountCount = accounts.length - successfulAccountCount
        remoteCompleted = true
        logInfo('search.load.complete', {
          account_count: accounts.length,
          success_count: successfulAccountCount,
          failed_account_count: failedAccountCount,
          result_count: remoteResults.length,
          has_next_page: responses.some((response) => response.status === 'fulfilled' && response.value.next_page_token !== null),
        })
        logPerformance('search.load', performance.now() - startedAt, { account_count: accounts.length })
        setSearchPageTokens((current) => {
          const next = { ...current }
          responses.forEach((response, index) => {
            if (response.status === 'fulfilled') next[accounts[index].id] = response.value.next_page_token
          })
          return next
        })
        publishResults()
        responses.forEach((response, index) => {
          if (response.status !== 'fulfilled') return
          void invoke('cache_search_messages', { accountId: accounts[index].id, query, page: response.value, append: false }).catch((error: unknown) => {
            logWarn('search.cache.write.failed', { error_type: getErrorType(error) })
            if (!cancelled && requestId === searchRequestIdRef.current) setToastMessage(getDisplayError(error))
          })
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
      setSearchPageTokens(Object.fromEntries(accounts.map((account) => [account.id, null])))
      void search()
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [accounts, deferredSearchQuery, getDisplayError, searchRetryNonce])

  useEffect(() => {
    if (!activeAccountId || activeFolder === 'inbox' || activeView !== 'mail') return
    let cancelled = false
    let networkCompleted = false
    let hasCachedPage = false
    const startedAt = performance.now()
    const folder = activeFolder
    logDebug('folder.load.start', { folder })
    void invoke<MessagePage | null>('get_cached_folder_messages', { accountId: activeAccountId, folder })
      .then((cachedPage) => {
        if (cancelled || networkCompleted || !cachedPage) return
        hasCachedPage = true
        logDebug('folder.cache.load.complete', { folder, message_count: cachedPage.messages.length })
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
          networkCompleted = true
          logInfo('folder.load.complete', { folder, message_count: page.messages.length, has_next_page: page.next_page_token !== null })
          logPerformance('folder.load', performance.now() - startedAt, { folder })
          setFolderMessages((current) => mergeMessageLists(current, page.messages))
          setFolderNextPageToken(page.next_page_token)
          setMailboxLoadError(false)
          void invoke('cache_folder_messages', { accountId: activeAccountId, folder, page, append: false }).catch((error: unknown) => {
            if (!cancelled) setToastMessage(getDisplayError(error))
          })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && !hasCachedPage) {
          logError('folder.load.failed', { folder, error_type: getErrorType(error) })
          logPerformance('folder.load.failed', performance.now() - startedAt, { folder })
          setMailboxLoadError(true)
          setToastMessage(getDisplayError(error))
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingFolder(false)
      })
    return () => { cancelled = true }
  }, [activeAccountId, activeFolder, activeView, getDisplayError])

  const loadNextPage = useCallback((source: 'auto' | 'manual' = 'manual') => {
    if (isUnifiedInbox) {
      if (activeView !== 'mail' || activeFolder !== 'inbox' || isLoadingMore) return
      if (source === 'auto' && autoPagingBlockedRef.current) return
      if (source === 'manual') autoPagingBlockedRef.current = false
      const pagesToLoad = Object.entries(unifiedNextPageTokens).filter((entry): entry is [string, string] => Boolean(entry[1]))
      if (pagesToLoad.length === 0) return
      const requestKey = pagesToLoad.map(([accountId, pageToken]) => `${accountId}:${pageToken}`).join('\u001f')
      if (requestKey === loadMoreRequestKeyRef.current) return
      const requestId = ++loadMoreRequestIdRef.current
      const startedAt = performance.now()
      loadMoreRequestKeyRef.current = requestKey
      setIsLoadingMore(true)
      logDebug('mailbox.page.load.start', {
        source,
        unified: true,
        account_count: pagesToLoad.length,
        token_count: pagesToLoad.length,
      })
      void Promise.allSettled(pagesToLoad.map(([accountId, pageToken]) => invoke<MessagePage>('list_messages', { accountId, pageToken })))
        .then((results) => {
          if (requestId !== loadMoreRequestIdRef.current || !isUnifiedInbox || activeFolder !== 'inbox' || activeView !== 'mail') {
            logDebug('mailbox.page.load.stale_response', { unified: true })
            return
          }
          let successfulCount = 0
          let firstFailure: unknown = null
          results.forEach((result, index) => {
            const accountId = pagesToLoad[index][0]
            if (result.status === 'rejected') {
              firstFailure ??= result.reason
              return
            }
            successfulCount += 1
            setUnifiedNextPageTokens((current) => ({ ...current, [accountId]: result.value.next_page_token }))
            setMessages((current) => mergeUnifiedAccountMessages(current, accountId, result.value.messages))
          })
          if (firstFailure) {
            loadMoreRequestKeyRef.current = null
            if (source === 'auto') autoPagingBlockedRef.current = true
            setMailboxLoadError(successfulCount === 0)
            logWarn('mailbox.page.load.partial_failure', {
              source,
              unified: true,
              account_count: pagesToLoad.length,
              success_count: successfulCount,
              error_type: getErrorType(firstFailure),
            })
            setToastMessage(getDisplayError(firstFailure))
          } else {
            setMailboxLoadError(false)
            logInfo('mailbox.page.load.complete', {
              source,
              unified: true,
              account_count: pagesToLoad.length,
              message_count: results.reduce((count, result) => result.status === 'fulfilled' ? count + result.value.messages.length : count, 0),
              has_next_page: results.some((result) => result.status === 'fulfilled' && result.value.next_page_token !== null),
            })
          }
          logPerformance('mailbox.page.load', performance.now() - startedAt, { source, unified: true })
        })
        .finally(() => {
          if (requestId === loadMoreRequestIdRef.current) setIsLoadingMore(false)
        })
      return
    }
    const pageToken = activeView === 'mail'
      ? activeFolder === 'inbox' && messagesAccountId === activeAccountId ? nextPageToken : activeFolder !== 'inbox' ? folderNextPageToken : null
      : null
    if (!activeAccountId || !pageToken || isLoadingMore) return
    if (source === 'auto' && autoPagingBlockedRef.current) return
    if (source === 'manual') autoPagingBlockedRef.current = false
    const requestedAccountId = activeAccountId
    const requestedFolder = activeFolder
    const requestKey = `${requestedAccountId}:${requestedFolder}:${pageToken}`
    if (requestKey === loadMoreRequestKeyRef.current) return
    const requestId = ++loadMoreRequestIdRef.current
    const startedAt = performance.now()
    loadMoreRequestKeyRef.current = requestKey
    setIsLoadingMore(true)
    logDebug('mailbox.page.load.start', {
      source,
      unified: false,
      folder: requestedFolder,
      token_present: true,
    })
    const loadPage = activeFolder === 'inbox'
      ? invoke<MessagePage>('list_messages', { accountId: activeAccountId, pageToken })
      : invoke<MessagePage>('list_folder_messages', { accountId: activeAccountId, folder: activeFolder, pageToken })
    void loadPage
      .then((page) => {
        if (requestId !== loadMoreRequestIdRef.current || requestedAccountId !== activeAccountId || requestedFolder !== activeFolder) {
          logDebug('mailbox.page.load.stale_response', { unified: false, folder: requestedFolder })
          return
        }
        setMailboxLoadError(false)
        if (activeFolder === 'inbox') {
          setMessages((current) => appendUniqueMessages(current, page.messages))
          setNextPageToken(page.next_page_token)
        } else {
          setFolderMessages((current) => appendUniqueMessages(current, page.messages))
          setFolderNextPageToken(page.next_page_token)
          void invoke('cache_folder_messages', { accountId: activeAccountId, folder: activeFolder, page, append: true }).catch((error: unknown) => setToastMessage(getDisplayError(error)))
        }
        logInfo('mailbox.page.load.complete', {
          source,
          unified: false,
          folder: requestedFolder,
          message_count: page.messages.length,
          has_next_page: page.next_page_token !== null,
        })
        logPerformance('mailbox.page.load', performance.now() - startedAt, { source, unified: false, folder: requestedFolder })
      })
      .catch((error: unknown) => {
        if (requestId !== loadMoreRequestIdRef.current || requestedAccountId !== activeAccountId || requestedFolder !== activeFolder) return
        loadMoreRequestKeyRef.current = null
        if (source === 'auto') autoPagingBlockedRef.current = true
        setMailboxLoadError(true)
        logError('mailbox.page.load.failed', { source, unified: false, folder: requestedFolder, error_type: getErrorType(error) })
        logPerformance('mailbox.page.load.failed', performance.now() - startedAt, { source, unified: false, folder: requestedFolder })
        setToastMessage(getDisplayError(error))
      })
      .finally(() => {
        if (requestId === loadMoreRequestIdRef.current) setIsLoadingMore(false)
      })
  }, [activeAccountId, activeFolder, activeView, folderNextPageToken, getDisplayError, isLoadingMore, isUnifiedInbox, messagesAccountId, nextPageToken, setFolderMessages, setFolderNextPageToken, setToastMessage, unifiedNextPageTokens])

  useEffect(() => {
    if (!selectedMessageId || !activeAccountId || activeView !== 'mail') return
    let cancelled = false
    const cachedMessage = selectableMessagesRef.current.find((message) => getMessageIdentity(message, activeAccountId) === selectedMessageId)
    if (!cachedMessage) return
    const messageAccountId = cachedMessage?.account_id ?? activeAccountId
    const messageId = cachedMessage.id
    const threadId = cachedMessage?.thread_id
    const hasCachedBody = Boolean(cachedMessage && (cachedMessage.body_html || (cachedMessage.body && cachedMessage.body !== cachedMessage.preview)))
    const startedAt = performance.now()
    logDebug('reader.load.start', { thread: Boolean(threadId), cached_body: hasCachedBody })
    if (threadId) {
      const threadKey = `${messageAccountId}:${threadId}`
      if (loadedThreadIdRef.current === threadKey) return
      loadedThreadIdRef.current = threadKey
      let canRenderCachedThread = hasCachedBody
      const applyThreadMessages = (loadedMessages: MailMessage[]) => {
        const messagesWithAccount = withAccountId(messageAccountId, loadedMessages)
        setThreadMessages(messagesWithAccount)
        setMessages((current) => appendUniqueMessages(current, messagesWithAccount))
        setFolderMessages((current) => appendUniqueMessages(current, messagesWithAccount))
      }
      void invoke<MailMessage[] | null>('get_cached_thread', { accountId: messageAccountId, threadId })
        .then((cachedMessages) => {
          if (cancelled || !cachedMessages?.length) return
          logDebug('reader.cache.load.complete', { thread: true, message_count: cachedMessages.length })
          const cachedSelectedMessage = cachedMessages.find((message) => getMessageIdentity(message, messageAccountId) === selectedMessageId)
          canRenderCachedThread = Boolean(cachedSelectedMessage && (cachedSelectedMessage.body_html || (cachedSelectedMessage.body && cachedSelectedMessage.body !== cachedSelectedMessage.preview)))
          applyThreadMessages(cachedMessages)
          if (canRenderCachedThread) {
            setMessageLoadErrorId(null)
            setLoadingMessageId(null)
          }
        })
        .catch((error: unknown) => {
          logWarn('reader.cache.load.failed', { thread: true, error_type: getErrorType(error) })
          if (!cancelled) setToastMessage(getDisplayError(error))
        })
      void invoke<MailMessage[]>('get_thread', { accountId: messageAccountId, threadId })
        .then((loadedMessages) => {
          if (loadedMessages.length === 0) throw new Error('EMPTY_CONVERSATION')
          if (cancelled) return
          applyThreadMessages(loadedMessages)
          setMessageLoadErrorId(null)
          setLoadingMessageId(null)
          logInfo('reader.load.complete', { thread: true, message_count: loadedMessages.length })
          logPerformance('reader.load', performance.now() - startedAt, { thread: true })
        })
        .catch((error: unknown) => {
          if (cancelled) return
          logError('reader.load.failed', { thread: true, error_type: getErrorType(error) })
          logPerformance('reader.load.failed', performance.now() - startedAt, { thread: true })
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
    if (hasCachedBody) {
      logDebug('reader.cache.hit', { thread: false })
      return
    }
    if (loadingMessageId !== selectedMessageId) return
    void invoke<MailMessage>('get_message', { accountId: messageAccountId, messageId })
      .then((loadedMessage) => {
        if (cancelled) return
        const loadedMessageWithAccount = { ...loadedMessage, account_id: messageAccountId }
        setMessages((current) => current.map((message) => getMessageIdentity(message, activeAccountId) === selectedMessageId ? loadedMessageWithAccount : message))
        setFolderMessages((current) => current.map((message) => getMessageIdentity(message, activeAccountId) === selectedMessageId ? loadedMessageWithAccount : message))
        setMessageLoadErrorId((current) => current === selectedMessageId ? null : current)
        setLoadingMessageId((current) => current === selectedMessageId ? null : current)
        logInfo('reader.load.complete', { thread: false, message_count: 1 })
        logPerformance('reader.load', performance.now() - startedAt, { thread: false })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        logError('reader.load.failed', { thread: false, error_type: getErrorType(error) })
        logPerformance('reader.load.failed', performance.now() - startedAt, { thread: false })
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
      if (allowWindowCloseRef.current) return
      if (hasUnsavedComposeContent()) {
        event.preventDefault()
        pendingWindowCloseAfterComposeRef.current = true
        setIsComposeCloseConfirmationOpen(true)
        return
      }
      if (settings.closeToTray) {
        event.preventDefault()
        void hideToTray().catch(handleWindowActionError)
        return
      }
      if (!settings.confirmOnClose) return
      event.preventDefault()
      setIsCloseConfirmationOpen(true)
    })
    return () => { void unlisten.then((removeListener) => removeListener()) }
  }, [handleWindowActionError, hasUnsavedComposeContent, hideToTray, settings.closeToTray, settings.confirmOnClose])

  useEffect(() => {
    if (!toastMessage) return
    const timeoutId = window.setTimeout(() => setToastMessage(''), 2200)
    return () => window.clearTimeout(timeoutId)
  }, [toastMessage])

  useEffect(() => {
    if (!undoableMessageAction) return
    const timeoutId = window.setTimeout(() => setUndoableMessageAction(null), 8000)
    return () => window.clearTimeout(timeoutId)
  }, [undoableMessageAction])

  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? accounts[0]
  const composeAccount = accounts.find((account) => account.id === composeAccountId) ?? activeAccount
  const composeAttachmentLimits = composeAccount?.provider === 'outlook' ? attachmentLimits.outlook : attachmentLimits.gmail
  const visibleMessages = selectableMessages
  const folderUnreadCounts = useMemo<Partial<Record<MailNavigationFolder, number>>>(() => {
    const counts: Partial<Record<MailNavigationFolder, number>> = {}
    const loadedMessages = activeFolder === 'inbox'
      ? selectableMessages
      : activeFolder !== 'starred'
        ? folderMessages
        : []
    if (activeFolder === 'inbox') counts.inbox = loadedMessages.filter((message) => message.unread).length
    if (activeFolder !== 'inbox' && activeFolder !== 'starred') counts[activeFolder] = loadedMessages.filter((message) => message.unread).length
    return counts
  }, [activeFolder, folderMessages, selectableMessages])
  const accountUnreadCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    messages.forEach((message) => {
      if (!message.unread) return
      const accountId = message.account_id ?? activeAccountId
      if (!accountId) return
      counts[accountId] = (counts[accountId] ?? 0) + 1
    })
    return counts
  }, [activeAccountId, messages])
  const activeSyncStatus: AccountSyncStatus = isUnifiedInbox && activeFolder === 'inbox'
    ? accounts.some((account) => accountSyncStatus[account.id] === 'syncing')
      ? 'syncing'
      : accounts.some((account) => accountSyncStatus[account.id] === 'error') ? 'error' : 'idle'
    : accountSyncStatus[activeAccountId] ?? 'idle'
  const visibleNextPageToken = activeView === 'mail'
    ? !isUnifiedInbox && activeFolder === 'inbox' && messagesAccountId === activeAccountId ? nextPageToken : !isUnifiedInbox && activeFolder !== 'inbox' ? folderNextPageToken : null
    : null
  const hasUnifiedNextPage = isUnifiedInbox && activeFolder === 'inbox' && Object.values(unifiedNextPageTokens).some(Boolean)
  useEffect(() => {
    if (activeView !== 'mail' || (!visibleNextPageToken && !hasUnifiedNextPage)) return
    const list = messageListRef.current
    const sentinel = loadMoreSentinelRef.current
    if (!list || !sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNextPage('auto')
    }, { root: list, rootMargin: '280px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeView, hasUnifiedNextPage, loadNextPage, visibleNextPageToken])
  const selectedMessage = visibleMessages.find((message) => getMessageIdentity(message, activeAccountId) === selectedMessageId) ?? null
  const selectedMessageAccount = selectedMessage?.account_id
    ? accounts.find((account) => account.id === selectedMessage.account_id) ?? activeAccount
    : activeAccount
  const selectedMessageCapabilities = providerCapabilitiesByAccount[selectedMessageAccount?.id ?? activeAccountId] ?? null
  const selectedMessageKey = selectedMessage ? getMessageIdentity(selectedMessage, activeAccountId) : null
  const contextMessage = contextMenu
    ? selectableMessages.find((message) => getMessageIdentity(message, activeAccountId) === contextMenu.messageId) ?? null
    : null
  const selectedMessageSubject = selectedMessage?.subject || t('noSubject')
  const selectedMessageSender = selectedMessage ? getSenderLabel(selectedMessage.sender, selectedMessage.address) : ''
  const selectedMessageRecipients = selectedMessage?.to?.length ? selectedMessage.to.join(', ') : selectedMessageAccount?.address ?? ''
  const selectedMessageTime = selectedMessage ? formatMessageTime(selectedMessage.time, settings, i18n.language) : ''
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
  const shouldShowMessageSelectionToolbar = Boolean(activeAccount && !shouldShowLoadingSkeleton && !(mailboxLoadError && filteredMessages.length === 0))
  const shouldShowMobileReader = !selectedMessage && (accounts.length === 0 || isMailboxBusy)
  const shouldShowReaderState = !selectedMessage && (accountLoadError || (!isLoadingAccounts && accounts.length === 0))
  const accountTabStopId = accounts.find((account) => account.id === activeAccountId)?.id ?? accounts[0]?.id

  const handleMailRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, messageKey: string) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const currentIndex = displayedMessages.findIndex((message) => getMessageIdentity(message, activeAccountId) === messageKey)
    if (currentIndex < 0) return
    const nextIndex = event.key === 'ArrowDown' ? Math.min(currentIndex + 1, displayedMessages.length - 1) : event.key === 'ArrowUp' ? Math.max(currentIndex - 1, 0) : event.key === 'Home' ? 0 : displayedMessages.length - 1
    if (nextIndex === currentIndex) return
    event.preventDefault()
    const nextMessage = displayedMessages[nextIndex]
      document.querySelector<HTMLButtonElement>(`[data-mail-id="${CSS.escape(getMessageIdentity(nextMessage, activeAccountId))}"]`)?.focus()
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
    clearBulkSelection()
    if (nextFilter !== activeFilter) clearReaderSelection()
    setActiveFilter(nextFilter)
    if (nextFilter === 'starred') {
      invalidateLoadMore()
      setIsUnifiedInbox(false)
      setActiveFolder('starred')
      setIsLoadingFolder(true)
      setFolderMessages([])
      setFolderNextPageToken(null)
      dismissSearch()
    } else if (activeFolder === 'starred') {
      invalidateLoadMore()
      setActiveFolder('inbox')
      setIsLoadingFolder(false)
      setFolderMessages([])
      setFolderNextPageToken(null)
    }
  }

  const selectAccount = (accountId: string) => {
    if (isComposing && accountId !== activeAccountId) {
      setToastMessage(t('closeComposerToSwitchAccount'))
      return
    }
    const accountChanged = accountId !== activeAccountId
    clearBulkSelection()
    clearReaderSelection()
    clearSearch()
    invalidateLoadMore()
    setIsUnifiedInbox(false)
    setActiveFolder('inbox')
    setActiveFilter('all')
    setFolderMessages([])
    setFolderNextPageToken(null)
    setUnifiedNextPageTokens({})
    setIsLoadingFolder(false)
    setActiveView('mail')
    if (!accountChanged) return
    setIsLoadingMessages(true)
    setMessages([])
    setMessagesAccountId(null)
    setNextPageToken(null)
    setUnifiedNextPageTokens({})
    setActiveAccountId(accountId)
  }

  const selectUnifiedInbox = () => {
    if (isComposing) {
      setToastMessage(t('closeComposerToSwitchAccount'))
      return
    }
    clearBulkSelection()
    clearReaderSelection()
    clearSearch()
    invalidateLoadMore()
    setIsUnifiedInbox(true)
    setActiveFolder('inbox')
    setActiveFilter('all')
    setFolderMessages([])
    setFolderNextPageToken(null)
    setIsLoadingFolder(false)
    setIsLoadingMessages(true)
    setMessages([])
    setMessagesAccountId(null)
    setNextPageToken(null)
    setUnifiedNextPageTokens({})
    setActiveView('mail')
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

  const selectMailFolder = (folder: MailNavigationFolder) => {
    clearBulkSelection()
    clearReaderSelection()
    dismissSearch()
    invalidateLoadMore()
    setIsUnifiedInbox(false)
    setActiveFolder(folder)
    setIsLoadingFolder(folder !== 'inbox')
    setActiveFilter(activeFilter === 'starred' ? 'all' : activeFilter)
    setFolderMessages([])
    setFolderNextPageToken(null)
  }

  const handleMailFolderKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, folder: MailNavigationFolder) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = MAIL_NAVIGATION_FOLDERS.indexOf(folder)
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? MAIL_NAVIGATION_FOLDERS.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + MAIL_NAVIGATION_FOLDERS.length) % MAIL_NAVIGATION_FOLDERS.length
    const nextFolder = MAIL_NAVIGATION_FOLDERS[nextIndex]
    selectMailFolder(nextFolder)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-mail-folder="${nextFolder}"]`)?.focus()
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

  const updateMessage = useCallback((messageKey: string, update: Partial<MailMessage>) => {
    setMessages((current) => current.map((message) => getMessageIdentity(message, activeAccountId) === messageKey ? { ...message, ...update } : message))
    setFolderMessages((current) => current.map((message) => getMessageIdentity(message, activeAccountId) === messageKey ? { ...message, ...update } : message))
    setThreadMessages((current) => current.map((message) => getMessageIdentity(message, activeAccountId) === messageKey ? { ...message, ...update } : message))
  }, [activeAccountId, setFolderMessages, setMessages, setThreadMessages])

  const removeMessageEverywhere = (messageKey: string) => {
    setMessages((current) => current.filter((message) => getMessageIdentity(message, activeAccountId) !== messageKey))
    setFolderMessages((current) => current.filter((message) => getMessageIdentity(message, activeAccountId) !== messageKey))
  }

  const removeMessageFromInbox = (messageKey: string) => {
    setMessages((current) => current.filter((message) => getMessageIdentity(message, activeAccountId) !== messageKey))
  }

  const isActionAvailable = useCallback((action: MessageAction, accountId = activeAccountId) => {
    const capabilities = providerCapabilitiesByAccount[accountId]
    if (!capabilities) return false
    switch (action) {
      case 'archive': return capabilities.can_archive
      case 'unarchive': return capabilities.can_archive
      case 'trash':
      case 'untrash': return capabilities.can_delete
      case 'delete_forever': return capabilities.can_permanently_delete
      case 'mark_read':
      case 'mark_unread': return capabilities.can_mark_read
      case 'star':
      case 'unstar': return capabilities.can_star
      case 'spam':
      case 'not_spam': return capabilities.can_spam
    }
  }, [activeAccountId, providerCapabilitiesByAccount])

  const isBulkActionAvailable = useCallback((action: MessageAction) => {
    const selectedMessages = filteredMessages.filter((message) => selectedMessageIds.has(getMessageIdentity(message, activeAccountId)))
    return selectedMessages.length > 0 && selectedMessages.every((message) => isActionAvailable(action, message.account_id ?? activeAccountId))
  }, [activeAccountId, filteredMessages, isActionAvailable, selectedMessageIds])

  const runMessageAction = useCallback((messageKey: string, action: MessageAction, onSuccess: () => void) => {
    const message = selectableMessagesRef.current.find((item) => getMessageIdentity(item, activeAccountId) === messageKey)
    const requestedAccountId = message?.account_id ?? activeAccountId
    const requestedFolder = activeFolder
    const requestedIsUnifiedInbox = isUnifiedInbox
    if (!message || !requestedAccountId || messageActionInFlightId || !isActionAvailable(action, requestedAccountId)) return
    setMessageActionInFlightId(messageKey)
    void invoke('modify_message', { accountId: requestedAccountId, messageId: message.id, action })
      .then(() => {
        const isCurrentView = requestedAccountId === activeAccountIdRef.current
          && requestedFolder === activeFolderRef.current
          && requestedIsUnifiedInbox === isUnifiedInboxRef.current
        if (isCurrentView) onSuccess()
      })
      .catch((error: unknown) => {
        setToastMessage(getDisplayError(error))
      })
      .finally(() => setMessageActionInFlightId((current) => current === messageKey ? null : current))
  }, [activeAccountId, activeFolder, getDisplayError, isActionAvailable, isUnifiedInbox, messageActionInFlightId, setToastMessage])

  const runBulkMessageAction = useCallback(async (action: MessageAction) => {
    const visibleMessageKeys = new Set(filteredMessages.map((message) => getMessageIdentity(message, activeAccountId)))
    const selectedMessages = filteredMessages.filter((message) => selectedMessageIds.has(getMessageIdentity(message, activeAccountId)) && visibleMessageKeys.has(getMessageIdentity(message, activeAccountId)))
    if (!activeAccountId || selectedMessages.length === 0 || bulkActionInFlight || selectedMessages.some((message) => !isActionAvailable(action, message.account_id ?? activeAccountId))) return
    const requestedAccountId = activeAccountId
    const requestedFolder = activeFolder
    const requestedIsUnifiedInbox = isUnifiedInbox
    const messagesByAccount = new Map<string, string[]>()
    selectedMessages.forEach((message) => {
      const accountId = message.account_id ?? activeAccountId
      const accountMessages = messagesByAccount.get(accountId) ?? []
      accountMessages.push(message.id)
      messagesByAccount.set(accountId, accountMessages)
    })
    setBulkActionInFlight(true)
    try {
      const accountEntries = Array.from(messagesByAccount.entries())
      const results = await Promise.allSettled(accountEntries.map(([accountId, messageIds]) => invoke<BulkMessageActionResult>('modify_messages', { accountId, messageIds, action })))
      const isCurrentView = requestedAccountId === activeAccountIdRef.current
        && requestedFolder === activeFolderRef.current
        && requestedIsUnifiedInbox === isUnifiedInboxRef.current
      if (!isCurrentView) return
      const failedMessageIds = results.flatMap((result, index) => result.status === 'fulfilled'
        ? result.value.failed_message_ids
        : accountEntries[index]?.[1] ?? [])
      const succeededKeys = new Set(results.flatMap((result, index) => {
        if (result.status !== 'fulfilled') return []
        const accountId = accountEntries[index]?.[0]
        return accountId ? result.value.succeeded_message_ids.map((id) => getMessageIdentity({ id, account_id: accountId })) : []
      }))
      if (action === 'archive' || action === 'trash' || action === 'delete_forever') {
        setMessages((current) => current.filter((message) => !succeededKeys.has(getMessageIdentity(message, activeAccountId))))
        setFolderMessages((current) => current.filter((message) => !succeededKeys.has(getMessageIdentity(message, activeAccountId))))
      } else if (action === 'mark_read' || action === 'mark_unread') {
        const unread = action === 'mark_unread'
        setMessages((current) => current.map((message) => succeededKeys.has(getMessageIdentity(message, activeAccountId)) ? { ...message, unread } : message))
        setFolderMessages((current) => current.map((message) => succeededKeys.has(getMessageIdentity(message, activeAccountId)) ? { ...message, unread } : message))
      }
      setSelectedMessageIds((current) => {
        const next = new Set(current)
        succeededKeys.forEach((messageKey) => next.delete(messageKey))
        return next
      })
      setToastMessage(failedMessageIds.length > 0
        ? t('bulkActionFailed', { count: failedMessageIds.length })
        : t('bulkActionComplete'))
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    } finally {
      setBulkActionInFlight(false)
    }
  }, [activeAccountId, activeFolder, bulkActionInFlight, filteredMessages, getDisplayError, isActionAvailable, isUnifiedInbox, selectedMessageIds, setFolderMessages, setMessages, setToastMessage, t])

  const archiveMessage = (messageId: string) => {
    const message = selectableMessagesRef.current.find((item) => getMessageIdentity(item, activeAccountId) === messageId)
    const accountId = message?.account_id ?? activeAccountId
    runMessageAction(messageId, 'archive', () => {
      if (message && accountId) setUndoableMessageAction({ accountId, messageId: message.id, action: 'unarchive' })
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
    const message = selectableMessagesRef.current.find((item) => getMessageIdentity(item, activeAccountId) === messageId)
    const accountId = message?.account_id ?? activeAccountId
    runMessageAction(messageId, 'spam', () => {
      if (message && accountId) setUndoableMessageAction({ accountId, messageId: message.id, action: 'not_spam' })
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
      const message = selectableMessagesRef.current.find((item) => getMessageIdentity(item, activeAccountId) === messageId)
      const accountId = message?.account_id ?? activeAccountId
      if (message && accountId) setUndoableMessageAction({ accountId, messageId: message.id, action: 'untrash' })
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

  useEffect(() => {
    if (!selectedMessageId || !activeAccountId || !selectedMessage?.unread || !selectedMessageCapabilities?.can_mark_read) return
    const timeoutId = window.setTimeout(() => markMessageRead(selectedMessageId), 0)
    return () => window.clearTimeout(timeoutId)
  }, [activeAccountId, markMessageRead, messageActionInFlightId, selectedMessage?.unread, selectedMessageCapabilities?.can_mark_read, selectedMessageId])

  const markMessageReadFromContext = (messageId: string) => {
    runMessageAction(messageId, 'mark_read', () => {
      updateMessage(messageId, { unread: false })
      setContextMenu(null)
      setToastMessage(t('markReadComplete'))
    })
  }

  const starMessage = (messageId: string) => {
    const message = selectableMessages.find((item) => getMessageIdentity(item, activeAccountId) === messageId)
    if (!message) return
    runMessageAction(messageId, message.starred ? 'unstar' : 'star', () => {
      updateMessage(messageId, { starred: !message.starred })
      setContextMenu(null)
      setToastMessage(t('starComplete'))
    })
  }

  const downloadAttachment = (attachment: Pick<MailAttachment, 'id' | 'filename'>, messageId = selectedMessageId) => {
    const message = messageId ? selectableMessagesRef.current.find((item) => getMessageIdentity(item, activeAccountId) === messageId) : undefined
    const requestedAccountId = message?.account_id ?? activeAccountId
    if (!requestedAccountId || !message || downloadingAttachmentId) return
    setDownloadingAttachmentId(attachment.id)
    void invoke<string>('download_attachment', {
      accountId: requestedAccountId,
      messageId: message.id,
      attachmentId: attachment.id,
      filename: attachment.filename,
    })
      .then(() => setToastMessage(t('attachmentDownloaded')))
      .catch((error: unknown) => setToastMessage(getDisplayError(error)))
      .finally(() => setDownloadingAttachmentId(null))
  }

  const updateSetting = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]): boolean => {
    const previous = settingsRef.current
    const next = { ...previous, [key]: value }
    try {
      saveSettings(next)
    } catch {
      setToastMessage(t('settingsSaveFailed'))
      return false
    }
    settingsRef.current = next
    setSettings(next)
    if (key === 'notificationsEnabled' && value === true && notificationPermission !== 'granted') {
      void requestNotificationPermission()
    }
    if (key === 'launchAtStartup') {
      const requestId = ++launchAtStartupRequestIdRef.current
      void invoke('set_launch_at_startup', { enabled: next.launchAtStartup }).catch((error: unknown) => {
        if (requestId !== launchAtStartupRequestIdRef.current || settingsRef.current.launchAtStartup !== next.launchAtStartup) return
        const reverted = { ...settingsRef.current, launchAtStartup: !next.launchAtStartup }
        try {
          saveSettings(reverted)
        } catch {
          settingsRef.current = reverted
          setSettings(reverted)
          setToastMessage(`${getDisplayError(error)} ${t('settingsSaveFailed')}`)
          return
        }
        settingsRef.current = reverted
        setSettings(reverted)
        setToastMessage(getDisplayError(error))
      })
    }
    return true
  }

  const configureAppLock = async () => {
    if (!isTauriRuntime()) return
    const pin = window.prompt(t('appLockPinPrompt'))?.trim()
    if (!pin) return
    const confirmation = window.prompt(t('appLockPinConfirmPrompt'))?.trim()
    if (pin !== confirmation) {
      setToastMessage(t('appLockPinMismatch'))
      return
    }
    try {
      await invoke('set_app_lock_pin', { pin })
      setAppLockConfigured(true)
      setToastMessage(t('appLockConfigured'))
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }

  const disableAppLock = async () => {
    if (!isTauriRuntime() || !window.confirm(t('disableAppLockConfirm'))) return
    try {
      await invoke('clear_app_lock_pin')
      setAppLockConfigured(false)
      setIsAppLocked(false)
      setToastMessage(t('appLockDisabled'))
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }

  const exportBackup = async () => {
    if (!isTauriRuntime()) return
    const password = window.prompt(t('backupPasswordPrompt'))?.trim()
    if (!password) return
    try {
      const saved = await invoke<boolean>('save_backup', { password })
      if (saved) setToastMessage(t('backupExported'))
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }

  const importBackup = async () => {
    if (!isTauriRuntime()) return
    let serialized: string | null
    try {
      serialized = await invoke<string | null>('read_backup')
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
      return
    }
    if (!serialized || !window.confirm(t('backupImportConfirm'))) return
    const password = window.prompt(t('backupPasswordPrompt'))?.trim()
    if (!password) return
    try {
      const restoredAccounts = await invoke<MailAccount[]>('import_backup', { password, serialized })
      setAccounts(restoredAccounts)
      setActiveAccountId('')
      setIsLoadingAccounts(true)
      setIsLoadingMessages(false)
      setMessages([])
      setFolderMessages([])
      setMessagesAccountId(null)
      setNextPageToken(null)
      setFolderNextPageToken(null)
      setUnifiedNextPageTokens({})
      setProviderCapabilitiesByAccount({})
      setAccountSyncStatus({})
      clearBulkSelection()
      clearReaderSelection()
      setSelectedMessageIds(new Set())
      setToastMessage(t('backupImported'))
      loadAccounts()
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }

  const lockApp = useCallback(() => {
    if (!appLockConfigured) return
    setAppLockPin('')
    setIsAppLocked(true)
  }, [appLockConfigured, setAppLockPin])

  const unlockApp = async () => {
    if (!appLockPin) return
    try {
      const verified = await invoke<boolean>('verify_app_lock_pin', { pin: appLockPin })
      if (!verified) {
        setAppLockPin('')
        setToastMessage(t('appLockPinWrong'))
        return
      }
      setAppLockPin('')
      setIsAppLocked(false)
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }

  const setDefaultAccount = (accountId: string) => {
    if (accountMutationInFlightRef.current) return
    accountMutationInFlightRef.current = true
    setIsAccountMutationInFlight(true)
    accountsLoadRequestIdRef.current += 1
    void invoke<MailAccount[]>('set_default_account', { accountId }).then((updatedAccounts) => {
      setAccounts(updatedAccounts)
      invalidateLoadMore()
      setDefaultAccountId(accountId)
      setIsLoadingMessages(true)
      setMessages([])
      setMessagesAccountId(null)
      setNextPageToken(null)
      setUnifiedNextPageTokens({})
      setFolderMessages([])
      setFolderNextPageToken(null)
      setIsLoadingFolder(false)
      clearSearch()
      clearReaderSelection()
      clearBulkSelection()
      setActiveAccountId(accountId)
      setActiveFolder('inbox')
      setActiveFilter('all')
      setActiveView('mail')
    }).catch((error: unknown) => setToastMessage(getDisplayError(error))).finally(() => {
      accountMutationInFlightRef.current = false
      setIsAccountMutationInFlight(false)
    })
  }

  const refreshMailbox = async () => {
    if (!activeAccountId || isRefreshing) return
    const requestedAccountId = activeAccountId
    const requestedFolder = activeFolder
    const requestedIsUnifiedInbox = isUnifiedInbox
    const refreshCandidates = requestedIsUnifiedInbox && activeFolder === 'inbox' ? accounts : activeAccount ? [activeAccount] : []
    const accountsToRefresh = refreshCandidates.filter((account) => !syncInFlightAccountsRef.current.has(account.id))
    if (accountsToRefresh.length === 0) return
    setIsRefreshing(true)
    accountsToRefresh.forEach((account) => syncInFlightAccountsRef.current.add(account.id))
    setAccountSyncStatus((current) => accountsToRefresh.reduce((next, account) => ({ ...next, [account.id]: 'syncing' as const }), current))
    try {
      if (activeFolder === 'inbox') {
        const results = await Promise.allSettled(accountsToRefresh.map((account) => invoke<SyncResult>('sync_messages', { accountId: account.id })))
        if (requestedAccountId !== activeAccountId || requestedFolder !== activeFolder || requestedIsUnifiedInbox !== isUnifiedInbox) return
        let successfulCount = 0
        let firstFailure: unknown = null
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            successfulCount += 1
            setAccountSyncStatus((current) => ({ ...current, [accountsToRefresh[index].id]: 'idle' }))
            const accountId = accountsToRefresh[index].id
            if (requestedIsUnifiedInbox) setUnifiedNextPageTokens((current) => ({ ...current, [accountId]: result.value.page.next_page_token }))
            setMessages((current) => {
              const withoutRemoved = removeMessagesForAccount(current, accountId, result.value.removed_message_ids)
              return requestedIsUnifiedInbox
                ? mergeUnifiedAccountMessages(withoutRemoved, accountId, result.value.page.messages)
                : mergeMessageLists(withoutRemoved, withAccountId(accountId, result.value.page.messages))
            })
          } else {
            setAccountSyncStatus((current) => ({ ...current, [accountsToRefresh[index].id]: 'error' }))
            firstFailure ??= result.reason
          }
        })
        if (!requestedIsUnifiedInbox) {
          const result = results[0]
          if (result.status === 'fulfilled') {
            setNextPageToken(result.value.page.next_page_token)
            setMessagesAccountId(activeAccountId)
          }
        }
        if (firstFailure) {
          setMailboxLoadError(successfulCount === 0)
          setToastMessage(`${t(successfulCount > 0 ? 'syncPartialFailed' : 'mailboxLoadFailed')}: ${getDisplayError(firstFailure)}`)
        } else {
          setMailboxLoadError(false)
          setToastMessage(t('syncComplete'))
        }
      } else {
        const folder = activeFolder
        const page = await invoke<MessagePage>('list_folder_messages', { accountId: activeAccountId, folder })
        if (requestedAccountId !== activeAccountId || requestedFolder !== activeFolder || requestedIsUnifiedInbox !== isUnifiedInbox) return
        setAccountSyncStatus((current) => ({ ...current, [activeAccountId]: 'idle' }))
        setFolderMessages((current) => mergeMessageLists(current, page.messages))
        setFolderNextPageToken(page.next_page_token)
        await invoke('cache_folder_messages', { accountId: activeAccountId, folder, page, append: false })
      }
      if (activeFolder !== 'inbox') setToastMessage(t('syncComplete'))
    } catch (error: unknown) {
      setAccountSyncStatus((current) => accountsToRefresh.reduce((next, account) => ({ ...next, [account.id]: 'error' as const }), current))
      setToastMessage(getDisplayError(error))
    } finally {
      accountsToRefresh.forEach((account) => {
        syncInFlightAccountsRef.current.delete(account.id)
      })
      setIsRefreshing(false)
    }
  }

  const stableRefreshMailbox = useStableCallback(refreshMailbox)

  const undoLastMessageAction = useCallback(async () => {
    const pendingAction = undoableMessageAction
    if (!pendingAction) return
    setUndoableMessageAction(null)
    try {
      await invoke('modify_message', pendingAction)
      setToastMessage(t('undoComplete'))
      await stableRefreshMailbox()
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }, [getDisplayError, stableRefreshMailbox, t, undoableMessageAction])

  const requestWindowClose = () => {
    if (!isTauriRuntime()) return
    if (hasUnsavedComposeContent()) {
      pendingWindowCloseAfterComposeRef.current = true
      setIsComposeCloseConfirmationOpen(true)
      return
    }
    if (settings.closeToTray) {
      void hideToTray().catch(handleWindowActionError)
      return
    }
    if (settings.confirmOnClose) {
      setIsCloseConfirmationOpen(true)
      return
    }
    closeWindowImmediately()
  }

  const confirmWindowClose = () => {
    if (!isTauriRuntime()) return
    setIsCloseConfirmationOpen(false)
    closeWindowImmediately()
  }

  const minimizeWindowToTray = () => {
    if (!isTauriRuntime()) return
    setIsCloseConfirmationOpen(false)
    void hideToTray().catch(handleWindowActionError)
  }

  const removeAccount = (accountId: string) => {
    if (accountMutationInFlightRef.current) return
    if (isComposing && composeAccountId === accountId) {
      setToastMessage(t('closeComposerBeforeRemoveAccount'))
      return
    }
    accountMutationInFlightRef.current = true
    setIsAccountMutationInFlight(true)
    accountsLoadRequestIdRef.current += 1
    void invoke<MailAccount[]>('remove_account', { accountId })
      .then((updatedAccounts) => {
        setAccounts(updatedAccounts)
        setUnifiedNextPageTokens((current) => {
          const next = { ...current }
          delete next[accountId]
          return next
        })
        if (isUnifiedInbox && activeAccountId !== accountId) {
          setMessages((current) => current.filter((message) => message.account_id !== accountId))
        }
        const nextAccount = updatedAccounts.find((account) => account.is_default) ?? updatedAccounts[0]
        setDefaultAccountId(nextAccount?.id ?? '')
        if (activeAccountId === accountId) {
          clearBulkSelection()
          invalidateLoadMore()
          setIsLoadingMessages(Boolean(nextAccount))
          setIsUnifiedInbox(isUnifiedInbox && updatedAccounts.length > 1)
          setActiveAccountId(nextAccount?.id ?? '')
          setActiveFolder('inbox')
          setActiveFilter('all')
          setIsLoadingFolder(false)
          setFolderNextPageToken(null)
          setMessages([])
          setMessagesAccountId(null)
          setNextPageToken(null)
          setUnifiedNextPageTokens({})
          setFolderMessages([])
          clearSearch()
          clearReaderSelection()
        }
        setToastMessage(t('accountRemoved'))
      })
      .catch((error: unknown) => {
        setToastMessage(getDisplayError(error))
        loadAccounts()
      })
      .finally(() => {
        accountMutationInFlightRef.current = false
        setIsAccountMutationInFlight(false)
      })
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
      let pollAuthState: number | null = null
      let settled = false
      const settle = (handler: () => void) => {
        if (settled) return
        settled = true
        if (pollAuthState !== null) window.clearTimeout(pollAuthState)
        handler()
      }
      const poll = async () => {
        if (settled) return
        attempts += 1
        try {
          const authState = await invoke<AuthState>('get_auth_status')
          if (settled) return
          if (authState.status === 'connected') {
            try {
              const loadedAccounts = await invoke<MailAccount[]>('list_accounts')
              if (settled) return
              setAccounts(loadedAccounts)
              setAccountLoadError(false)
              const defaultAccount = loadedAccounts.find((account) => account.is_default) ?? loadedAccounts[0]
              setDefaultAccountId(defaultAccount?.id ?? '')
              if (authState.account_id) {
                invalidateLoadMore()
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
                clearBulkSelection()
                setActiveAccountId(authState.account_id)
                setActiveFolder('inbox')
                setActiveView('mail')
              }
              settle(resolve)
            } catch (error) {
              settle(() => reject(error))
            }
          } else if (authState.status === 'failed') {
            const message = getDisplayError(authState.error ?? (provider === 'outlook' ? t('outlookAuthFailed') : t('gmailAuthFailed')))
            setToastMessage(message)
            settle(() => reject(new Error(message)))
          } else if (attempts >= 600) {
            const message = provider === 'outlook' ? t('outlookAuthTimedOut') : t('gmailAuthTimedOut')
            setToastMessage(message)
            settle(() => reject(new Error(message)))
          } else {
            pollAuthState = window.setTimeout(() => {
              void poll()
            }, 500)
          }
        } catch (error) {
          settle(() => reject(error))
        }
      }
      void poll()
    })
  }

  const openReply = () => {
    if (!selectedMessageCapabilities?.can_reply) return
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
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable) return
      event.preventDefault()
      closeReader()
    }
    window.addEventListener('keydown', handleReaderKeyDown)
    return () => window.removeEventListener('keydown', handleReaderKeyDown)
  }, [activeView, closeReader, selectedMessageId])

  useEffect(() => {
    const handleGlobalShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' || document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const target = event.target
      const isEditableTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable
      if (isEditableTarget && target !== searchInputRef.current) return
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
    searchLoadRequestIdRef.current += 1
    searchLoadMoreRequestKeyRef.current = null
    searchAutoPagingBlockedRef.current = false
    setContextMenu(null)
    setSearchQuery(value)
    setSearchResults([])
    setSearchPageTokens({})
    setIsLoadingMoreSearch(false)
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
    searchLoadRequestIdRef.current += 1
    searchLoadMoreRequestKeyRef.current = null
    searchAutoPagingBlockedRef.current = false
    setIsLoadingMoreSearch(false)
    setSearchError(false)
    setSearchRetryNonce((current) => current + 1)
  }

  const loadMoreSearch = (source: 'auto' | 'manual' = 'manual') => {
    const query = searchQuery.trim()
    const requestedSearchRequestId = searchRequestIdRef.current
    const accountsWithNextPage = accounts.filter((account) => searchPageTokens[account.id])
    if (!query || accountsWithNextPage.length === 0 || isLoadingMoreSearch) return
    if (source === 'auto' && searchAutoPagingBlockedRef.current) return
    if (source === 'manual') searchAutoPagingBlockedRef.current = false
    const requestKey = accountsWithNextPage.map((account) => `${account.id}:${searchPageTokens[account.id]}`).join('\u001f')
    if (requestKey === searchLoadMoreRequestKeyRef.current) return
    const loadRequestId = ++searchLoadRequestIdRef.current
    const startedAt = performance.now()
    searchLoadMoreRequestKeyRef.current = requestKey
    setIsLoadingMoreSearch(true)
    logDebug('search.page.load.start', {
      source,
      account_count: accountsWithNextPage.length,
      query_length: query.length,
    })
    const responsesPromise = Promise.allSettled(accountsWithNextPage.map((account) => invoke<MessagePage>('search_messages', {
      accountId: account.id,
      query,
      pageToken: searchPageTokens[account.id],
    })))
    void responsesPromise.then((responses) => {
      if (loadRequestId !== searchLoadRequestIdRef.current || requestedSearchRequestId !== searchRequestIdRef.current || query !== searchQuery.trim()) {
        logDebug('search.page.load.stale_response', { source })
        return
      }
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
      const firstFailure = responses.find((response): response is PromiseRejectedResult => response.status === 'rejected')
      if (firstFailure) {
        searchLoadMoreRequestKeyRef.current = null
        if (source === 'auto') searchAutoPagingBlockedRef.current = true
        setSearchPartialError(true)
        logWarn('search.page.load.partial_failure', { source, account_count: accountsWithNextPage.length, error_type: getErrorType(firstFailure.reason) })
      } else {
        logInfo('search.page.load.complete', {
          source,
          account_count: accountsWithNextPage.length,
          result_count: nextResults.length,
          has_next_page: responses.some((response) => response.status === 'fulfilled' && response.value.next_page_token !== null),
        })
      }
      logPerformance('search.page.load', performance.now() - startedAt, { source, account_count: accountsWithNextPage.length })
      responses.forEach((response, index) => {
        if (response.status !== 'fulfilled') return
        void invoke('cache_search_messages', { accountId: accountsWithNextPage[index].id, query, page: response.value, append: true }).catch((error: unknown) => {
          logWarn('search.cache.write.failed', { error_type: getErrorType(error) })
          if (loadRequestId === searchLoadRequestIdRef.current && requestedSearchRequestId === searchRequestIdRef.current) setToastMessage(getDisplayError(error))
        })
      })
    }).finally(() => {
      if (loadRequestId === searchLoadRequestIdRef.current) setIsLoadingMoreSearch(false)
    })
  }

  const cacheSentMessage = async (messageId: string, requestedAccountId = composeAccountId ?? activeAccountId) => {
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
    const replyAccountId = selectedMessage?.account_id ?? activeAccountId
    const replyAccount = accounts.find((account) => account.id === replyAccountId)
    if (!selectedMessage || !replyAccount?.address || isSendingReply || !selectedMessageCapabilities?.can_reply) return
    setIsSendingReply(true)
    const subject = /^re:/i.test(selectedMessage.subject.trim()) ? selectedMessage.subject : `Re: ${selectedMessage.subject}`
    try {
      const sentMessageId = await invoke<string>('send_reply', {
        accountId: replyAccountId,
        messageId: selectedMessage.id,
        sender: replyAccount.address,
        recipient: selectedMessage.address,
        subject,
        body: replyDraft,
        threadId: selectedMessage.thread_id,
        inReplyTo: selectedMessage.message_id_header,
      })
      setIsReplying(false)
      setReplyDraft('')
      setToastMessage(t('replySent'))
      void cacheSentMessage(sentMessageId, replyAccountId)
    } catch (error) {
      setToastMessage(`${t('replySendFailed')} ${getDisplayError(error)}`)
    } finally {
      setIsSendingReply(false)
    }
  }

  const resetComposer = () => {
    if (isSendingMessage) return
    composeOpenSequenceRef.current += 1
    composeRevisionRef.current += 1
    draftListRequestIdRef.current += 1
    draftLoadRequestIdRef.current += 1
    setIsComposing(false)
    setIsDraftsPanelOpen(false)
    setComposeAccountId(null)
    setComposeDraftId(null)
    setComposeRecipient('')
    setComposeCc('')
    setComposeBcc('')
    setComposeSubject('')
    setComposeBody('')
    setComposeBodyHtml('')
    setComposeScheduleAt('')
    setComposeAttachments([])
    setDraftStatus('idle')
  }

  const closeWindowImmediately = () => {
    if (!isTauriRuntime()) return
    allowWindowCloseRef.current = true
    setIsCloseConfirmationOpen(false)
    void getCurrentWindow().close().catch((error: unknown) => {
      allowWindowCloseRef.current = false
      handleWindowActionError(error)
    })
  }

  const cancelComposeCloseConfirmation = () => {
    pendingWindowCloseAfterComposeRef.current = false
    setIsComposeCloseConfirmationOpen(false)
  }

  const discardComposer = async () => {
    if (isSendingMessage || draftSaveInFlightRef.current) return
    const shouldCloseWindow = pendingWindowCloseAfterComposeRef.current
    const draftId = composeDraftId
    const accountId = composeAccountId ?? activeAccountId
    if (draftId && accountId && isTauriRuntime()) {
      try {
        await invoke('delete_draft', { accountId, draftId })
        setComposeDrafts((current) => current.filter((item) => item.id !== draftId))
      } catch (error: unknown) {
        setToastMessage(`${t('draftDeleteFailed')} ${getDisplayError(error)}`)
        return
      }
    }
    pendingWindowCloseAfterComposeRef.current = false
    setIsComposeCloseConfirmationOpen(false)
    resetComposer()
    if (shouldCloseWindow) closeWindowImmediately()
  }

  const closeComposer = () => {
    if (isSendingMessage || draftSaveInFlightRef.current) return
    const hasComposeContent = [composeRecipient, composeCc, composeBcc, composeSubject, composeBody].some((value) => value.trim().length > 0) || composeAttachments.length > 0
    if (hasComposeContent && draftStatus === 'idle') {
      pendingWindowCloseAfterComposeRef.current = false
      setIsComposeCloseConfirmationOpen(true)
      return
    }
    pendingWindowCloseAfterComposeRef.current = false
    resetComposer()
  }

  const refreshComposeDrafts = async (accountId = composeAccountId ?? activeAccountId) => {
    if (!accountId || !isTauriRuntime()) return
    const requestId = ++draftListRequestIdRef.current
    const composeGeneration = composeOpenSequenceRef.current
    setIsLoadingDrafts(true)
    try {
      const drafts = await invoke<DraftListItem[]>('list_drafts', { accountId })
      if (requestId !== draftListRequestIdRef.current || composeGeneration !== composeOpenSequenceRef.current) return
      setComposeDrafts(drafts)
    } catch (error) {
      if (requestId !== draftListRequestIdRef.current || composeGeneration !== composeOpenSequenceRef.current) return
      setToastMessage(`${t('draftLoadFailed')} ${getDisplayError(error)}`)
    } finally {
      if (requestId === draftListRequestIdRef.current && composeGeneration === composeOpenSequenceRef.current) setIsLoadingDrafts(false)
    }
  }

  const refreshScheduledMessages = async () => {
    try {
      setScheduledMessages(await invoke<ScheduledMessageSummary[]>('list_scheduled_messages'))
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }

  const cancelScheduledMessage = async (message: ScheduledMessageSummary) => {
    try {
      await invoke('cancel_scheduled_message', { id: message.id })
      setScheduledMessages((current) => current.filter((item) => item.id !== message.id))
    } catch (error: unknown) {
      setToastMessage(getDisplayError(error))
    }
  }

  const saveCurrentComposeDraft = async (): Promise<boolean> => {
    const accountId = composeAccountId ?? activeAccountId
    const composeAccount = accounts.find((account) => account.id === accountId)
    if (!composeAccount?.address || !accountId || isSendingMessage || draftSaveInFlightRef.current) return false
    const hasContent = [composeRecipient, composeCc, composeBcc, composeSubject, composeBody].some((value) => value.trim().length > 0) || composeAttachments.length > 0
    if (!hasContent) return false
    const composeGeneration = composeOpenSequenceRef.current
    const composeRevision = composeRevisionRef.current
    draftSaveInFlightRef.current = true
    setDraftStatus('saving')
    try {
      const draft = await invoke<MailDraft>('save_draft', {
        accountId,
        sender: composeAccount.address,
        draftId: composeDraftId,
        recipient: splitEmailAddresses(composeRecipient).join(', '),
        cc: splitEmailAddresses(composeCc).join(', '),
        bcc: splitEmailAddresses(composeBcc).join(', '),
        subject: composeSubject.trim(),
        body: composeBody,
        bodyHtml: sanitizeComposeHtml(composeBodyHtml),
        attachments: composeAttachments.map(({ filename, mimeType, dataBase64 }) => ({ filename, mimeType, dataBase64 })),
      })
      if (composeGeneration !== composeOpenSequenceRef.current) return false
      setComposeDraftId(draft.id)
      await refreshComposeDrafts(accountId)
      if (composeRevision !== composeRevisionRef.current) {
        setDraftStatus('idle')
        return false
      }
      setDraftStatus('saved')
      setToastMessage(t('draftSaved'))
      return true
    } catch (error: unknown) {
      setDraftStatus('idle')
      setToastMessage(`${t('draftSaveFailed')} ${getDisplayError(error)}`)
      return false
    } finally {
      draftSaveInFlightRef.current = false
    }
  }

  const saveAndCloseComposer = async () => {
    const shouldCloseWindow = pendingWindowCloseAfterComposeRef.current
    const saved = await saveCurrentComposeDraft()
    if (!saved) return
    pendingWindowCloseAfterComposeRef.current = false
    setIsComposeCloseConfirmationOpen(false)
    resetComposer()
    if (shouldCloseWindow) closeWindowImmediately()
  }

  const deleteComposeDraft = async (draft: DraftListItem) => {
    const accountId = composeAccountId ?? activeAccountId
    if (!accountId || draftSaveInFlightRef.current) return
    const composeGeneration = composeOpenSequenceRef.current
    try {
      await invoke('delete_draft', { accountId, draftId: draft.id })
      if (composeGeneration !== composeOpenSequenceRef.current) return
      setComposeDrafts((current) => current.filter((item) => item.id !== draft.id))
      if (composeDraftId === draft.id) {
        composeRevisionRef.current += 1
        setComposeDraftId(null)
        setDraftStatus('idle')
      }
    } catch (error: unknown) {
      if (composeGeneration !== composeOpenSequenceRef.current) return
      setToastMessage(`${t('draftDeleteFailed')} ${getDisplayError(error)}`)
    }
  }

  const selectComposeDraft = async (draft: DraftListItem) => {
    if (isSendingMessage || draftSaveInFlightRef.current) return
    const accountId = composeAccountId ?? activeAccountId
    if (!accountId) return
    const requestId = ++draftLoadRequestIdRef.current
    const composeGeneration = composeOpenSequenceRef.current
    const composeRevision = composeRevisionRef.current
    try {
      const loadedDraft = await invoke<MailDraft>('get_draft', { accountId, draftId: draft.id })
      if (requestId !== draftLoadRequestIdRef.current || composeGeneration !== composeOpenSequenceRef.current || composeRevision !== composeRevisionRef.current) return
      composeRevisionRef.current += 1
      setComposeDraftId(loadedDraft.id)
      setComposeRecipient(loadedDraft.recipient)
      setComposeCc(loadedDraft.cc)
      setComposeBcc(loadedDraft.bcc)
      setComposeSubject(loadedDraft.subject)
      setComposeBody(loadedDraft.body)
      setComposeBodyHtml(sanitizeComposeHtml(loadedDraft.bodyHtml))
      setComposeScheduleAt('')
      setComposeAttachments(loadedDraft.attachments)
      setDraftStatus('saved')
      setIsDraftsPanelOpen(false)
    } catch (error: unknown) {
      if (requestId !== draftLoadRequestIdRef.current || composeGeneration !== composeOpenSequenceRef.current) return
      setToastMessage(`${t('draftLoadFailed')} ${getDisplayError(error)}`)
    }
  }

  const saveComposeRecipient = (email: string) => {
    try {
      setSavedRecipients(saveRecipient(email))
      setToastMessage(t('recipientSaved'))
    } catch {
      setToastMessage(t('recipientSaveFailed'))
    }
  }

  const openComposer = async () => {
    if (!activeProviderCapabilities?.can_send) return
    composeOpenSequenceRef.current += 1
    composeRevisionRef.current += 1
    draftLoadRequestIdRef.current += 1
    const accountId = activeAccountId
    setComposeAccountId(accountId)
    setComposeDraftId(null)
    setIsDraftsPanelOpen(false)
    setComposeAttachments([])
    setComposeScheduleAt('')
    void refreshComposeDrafts(accountId)
    setIsComposing(true)
    setDraftStatus('idle')
  }

  const submitMessage = async (attachments: ComposeAttachment[]) => {
    const composeTargetAccountId = composeAccountId ?? activeAccountId
    const composeTargetAccount = accounts.find((account) => account.id === composeTargetAccountId)
    const composeTargetCapabilities = providerCapabilitiesByAccount[composeTargetAccountId]
    if (!composeTargetAccount?.address || !composeTargetCapabilities?.can_send || !areValidEmailAddresses(composeRecipient) || (composeCc.trim() && !areValidEmailAddresses(composeCc)) || (composeBcc.trim() && !areValidEmailAddresses(composeBcc)) || !composeSubject.trim() || !composeBody.trim() || isSendingMessage || draftSaveInFlightRef.current) return
    setIsSendingMessage(true)
    let draftDeletionFailed = false
    try {
      const messagePayload = {
        accountId: composeTargetAccountId,
        sender: composeTargetAccount.address,
        recipient: splitEmailAddresses(composeRecipient).join(', '),
        cc: splitEmailAddresses(composeCc).join(', '),
        bcc: splitEmailAddresses(composeBcc).join(', '),
        subject: composeSubject.trim(),
        body: composeBody,
        bodyHtml: sanitizeComposeHtml(composeBodyHtml),
        attachments: attachments.map(({ filename, mimeType, dataBase64 }) => ({ filename, mimeType, dataBase64 })),
      }
      const scheduledAt = composeScheduleAt ? Date.parse(composeScheduleAt) : null
      if (composeScheduleAt && (scheduledAt === null || !Number.isFinite(scheduledAt) || scheduledAt <= Date.now())) {
        setToastMessage(t('scheduleTimeInvalid'))
        return
      }
      const sentMessageId = scheduledAt === null
        ? await invoke<string>('send_message', messagePayload)
        : (await invoke('schedule_message', { ...messagePayload, scheduledAt }), null)
      setIsComposing(false)
      setComposeRecipient('')
      setComposeCc('')
      setComposeBcc('')
      setComposeSubject('')
      setComposeBody('')
      setComposeBodyHtml('')
      setComposeAttachments([])
      setComposeScheduleAt('')
      if (composeDraftId) {
        try {
          await invoke('delete_draft', { accountId: composeTargetAccountId, draftId: composeDraftId })
          setComposeDrafts((current) => current.filter((item) => item.id !== composeDraftId))
        } catch (error: unknown) {
          draftDeletionFailed = true
          setToastMessage(`${t('draftDeleteFailed')} ${getDisplayError(error)}`)
        }
      }
      setComposeDraftId(null)
      setIsDraftsPanelOpen(false)
      setToastMessage(scheduledAt === null
        ? draftDeletionFailed ? `${t('messageSent')} ${t('draftDeleteFailed')}` : t('messageSent')
        : t('messageScheduled'))
      if (sentMessageId) void cacheSentMessage(sentMessageId, composeTargetAccountId)
    } catch (error) {
      setToastMessage(`${t('messageSendFailed')} ${getDisplayError(error)}`)
    } finally {
      setIsSendingMessage(false)
    }
  }

  const selectMessage = (messageId: string) => {
    const nextMessage = visibleMessages.find((item) => getMessageIdentity(item, activeAccountId) === messageId)
    if (nextMessage) selectReaderMessage(nextMessage)
  }

  useEffect(() => {
    if (!selectedMessageId || activeView !== 'mail') return undefined
    const mobileViewport = window.matchMedia('(max-width: 680px)')
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

  const selectReaderMessage = useCallback((nextMessage: MailMessage) => {
    const messageWithAccount = nextMessage.account_id ? nextMessage : { ...nextMessage, account_id: activeAccountId }
    const messageKey = getMessageIdentity(messageWithAccount, activeAccountId)
    const needsBody = !messageWithAccount.body_html && (!messageWithAccount.body || messageWithAccount.body === messageWithAccount.preview)
    setSelectedMessageId(messageKey)
    setThreadMessages(messageWithAccount.body_html || (messageWithAccount.body && messageWithAccount.body !== messageWithAccount.preview) ? [messageWithAccount] : [])
    loadedThreadIdRef.current = null
    setMessageLoadErrorId(null)
    setIsReaderDetailsOpen(false)
    setIsReaderScrolled(false)
    setLoadingMessageId(needsBody ? messageKey : null)
    setContextMenu(null)
  }, [activeAccountId])

  const stableSelectAccount = useStableCallback(selectAccount)
  const stableSelectUnifiedInbox = useStableCallback(selectUnifiedInbox)
  const stableRequestArchiveMessage = useStableCallback(requestArchiveMessage)
  const stableRestoreMessage = useStableCallback(restoreMessage)
  const stableStarMessage = useStableCallback(starMessage)
  const stableOpenReply = useStableCallback(openReply)
  const stableOpenComposer = useStableCallback(openComposer)
  const stableSelectMessage = useStableCallback(selectMessage)
  const stableHandleMailContextMenu = useStableCallback(handleMailContextMenu)
  const stableHandleMailRowKeyDown = useStableCallback(handleMailRowKeyDown)

  const openNotificationDestination = useCallback(async (destination: NotificationDestination) => {
    if (!accounts.some((account) => account.id === destination.accountId)) return
    pendingNotificationDestinationRef.current = destination
    await restoreWindow()
    clearBulkSelection()
    clearReaderSelection()
    clearSearch()
    invalidateLoadMore()
    setIsUnifiedInbox(false)
    setActiveFolder('inbox')
    setActiveFilter('all')
    setActiveView('mail')
    setActiveAccountId(destination.accountId)
  }, [accounts, clearBulkSelection, clearReaderSelection, clearSearch, invalidateLoadMore, restoreWindow, setActiveView])

  useEffect(() => {
    const destination = pendingNotificationDestinationRef.current
    if (!destination || activeView !== 'mail' || activeAccountId !== destination.accountId) return
    const message = selectableMessages.find((item) => item.id === destination.messageId || item.thread_id === destination.threadId)
    if (!message) return
    pendingNotificationDestinationRef.current = null
    selectReaderMessage(message)
  }, [activeAccountId, activeView, selectableMessages, selectReaderMessage])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    let notificationListener: (() => void) | undefined
    void listen<string>(NOTIFICATION_ACTION_EVENT, ({ payload: key }) => {
      const destination = consumeNotificationDestination(key)
      if (!destination) return
      void openNotificationDestination(destination).catch(() => {
        if (!cancelled) setToastMessage(t('notificationActionUnavailable'))
      })
    }).then((remove) => {
      if (cancelled) void remove()
      else notificationListener = remove
    }).catch(() => {
      if (!cancelled) setToastMessage(t('notificationActionUnavailable'))
    })
    return () => {
      cancelled = true
      if (notificationListener) notificationListener()
    }
  }, [openNotificationDestination, t])

  const selectSearchResult = (result: MailSearchResult) => {
    const nextMessage = { ...result.message, account_id: result.account.id }
    const isCurrentAccount = result.account.id === messagesAccountId
    clearReaderSelection()
    clearSearch()
    invalidateLoadMore()
    setIsUnifiedInbox(false)
    setActiveView('mail')
    setActiveAccountId(result.account.id)
    setActiveFolder('inbox')
    setActiveFilter('all')
    setFolderMessages([])
    setFolderNextPageToken(null)
    setMessagesAccountId(result.account.id)
    setMessages((current) => isCurrentAccount ? appendUniqueMessages(current, [nextMessage]) : [nextMessage])
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

  useEffect(() => {
    mailShortcutContextRef.current = {
      accounts,
      activeAccountId,
      activeFolder,
      activeProviderCapabilities,
      activeView,
      displayedMessages,
      isActionAvailable,
      isUnifiedInbox,
      markMessageRead,
      openComposer: stableOpenComposer,
      openReply: stableOpenReply,
      readerArchiveAction,
      refreshMailbox: stableRefreshMailbox,
      requestArchiveMessage: stableRequestArchiveMessage,
      restoreMessage: stableRestoreMessage,
      selectAccount: stableSelectAccount,
      selectReaderMessage,
      selectUnifiedInbox: stableSelectUnifiedInbox,
      selectedMessage,
      selectedMessageAccount,
      selectedMessageCapabilities,
      selectedMessageKey,
      starMessage: stableStarMessage,
    }
  }, [accounts, activeAccountId, activeFolder, activeProviderCapabilities, activeView, displayedMessages, isActionAvailable, isUnifiedInbox, markMessageRead, readerArchiveAction, selectedMessage, selectedMessageAccount, selectedMessageCapabilities, selectedMessageKey, selectReaderMessage, stableOpenComposer, stableOpenReply, stableRefreshMailbox, stableRequestArchiveMessage, stableRestoreMessage, stableSelectAccount, stableSelectUnifiedInbox, stableStarMessage])

  useEffect(() => {
    const handleMailShortcuts = (event: globalThis.KeyboardEvent) => {
      const context = mailShortcutContextRef.current
      if (!context) return
      const target = event.target
      const isEditableTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable
      if (isEditableTarget || document.querySelector('[role="dialog"][aria-modal="true"]')) return

      const key = event.key.toLowerCase()
      const hasCommandModifier = event.ctrlKey || event.metaKey
      if (event.key === 'F5' && context.activeAccountId) {
        event.preventDefault()
        void context.refreshMailbox()
        return
      }
      if (hasCommandModifier && event.shiftKey) {
        if (key === 'p') {
          event.preventDefault()
          setIsCommandPaletteOpen(true)
          return
        }
        if (key === 'l' && appLockConfigured) {
          event.preventDefault()
          lockApp()
          return
        }
        if (key === 'a' && context.accounts.length > 0) {
          event.preventDefault()
          setIsAccountSwitcherOpen(true)
          return
        }
        if (/^[0-9]$/.test(key)) {
          const accountIndex = key === '0' ? -1 : Number(key) - 1
          event.preventDefault()
          if (accountIndex < 0) context.selectUnifiedInbox()
          else if (context.accounts[accountIndex]) context.selectAccount(context.accounts[accountIndex].id)
          return
        }
      }
      if (hasCommandModifier && key === ',') {
        event.preventDefault()
        setIsCommandPaletteOpen(false)
        setOpenAddAccount(false)
        navigateToSettings()
        return
      }
      if (hasCommandModifier || context.activeView !== 'mail') return
      if (key === 'c' && context.activeProviderCapabilities?.can_send) {
        event.preventDefault()
        void context.openComposer()
        return
      }
      if (!context.selectedMessageKey || !context.selectedMessage) return
      if (key === 'r' && context.selectedMessageCapabilities?.can_reply) {
        event.preventDefault()
        context.openReply()
        return
      }
      if (key === 'a' && context.isActionAvailable(context.readerArchiveAction, context.selectedMessageAccount?.id ?? context.activeAccountId)) {
        event.preventDefault()
        if (context.activeFolder === 'trash' || context.activeFolder === 'spam') context.restoreMessage(context.selectedMessageKey)
        else context.requestArchiveMessage(context.selectedMessageKey)
        return
      }
      if (key === 'e' && context.isActionAvailable('mark_read', context.selectedMessageAccount?.id ?? context.activeAccountId)) {
        event.preventDefault()
        context.markMessageRead(context.selectedMessageKey)
        return
      }
      if (key === 's' && context.isActionAvailable(context.selectedMessage.starred ? 'unstar' : 'star', context.selectedMessageAccount?.id ?? context.activeAccountId)) {
        event.preventDefault()
        context.starMessage(context.selectedMessageKey)
        return
      }
      if (key !== 'j' && key !== 'k') return
      const currentIndex = context.displayedMessages.findIndex((message) => getMessageIdentity(message, context.activeAccountId) === context.selectedMessageKey)
      const nextIndex = key === 'j' ? Math.min(currentIndex + 1, context.displayedMessages.length - 1) : Math.max(currentIndex - 1, 0)
      const nextMessage = context.displayedMessages[nextIndex]
      if (currentIndex >= 0 && nextMessage && nextIndex !== currentIndex) {
        event.preventDefault()
        context.selectReaderMessage(nextMessage)
      }
    }
    window.addEventListener('keydown', handleMailShortcuts)
    return () => window.removeEventListener('keydown', handleMailShortcuts)
  }, [appLockConfigured, lockApp, navigateToSettings])

  return (
    <main className={`app-shell ${isSidebarExpanded ? 'sidebar-expanded' : ''}`} onContextMenu={handleContextMenu} onClick={() => setContextMenu(null)}>
      <WindowHeader
        onRequestClose={requestWindowClose}
        onWindowActionError={handleWindowActionError}
        onHideToTray={hideToTray}
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
        {isSearchOpen ? <Suspense fallback={null}><MailSearchDialog
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
        /></Suspense> : null}
      </WindowHeader>
      <aside className="sidebar" aria-label={t('navigation')}>
        <nav id="account-rail-nav" ref={accountListRef} className={`account-list ${isSidebarExpanded ? 'expanded' : ''}`} aria-label={t('accounts')}>
          {accounts.map((account) => (
            <AccountButton key={account.id} account={account} active={!isUnifiedInbox && activeAccountId === account.id} syncStatus={accountSyncStatus[account.id] ?? 'idle'} unreadCount={accountUnreadCounts[account.id]} expanded={isSidebarExpanded} providerLogos={providerLogos} tabIndex={account.id === accountTabStopId ? 0 : -1} onSelect={() => selectAccount(account.id)} onKeyDown={(event) => handleAccountKeyDown(event, account.id)} />
          ))}
          {!isLoadingAccounts ? <div className="account-rail-utilities">
            {accounts.length > 1 ? <button className={`account-button all-accounts-button ${isUnifiedInbox ? 'active' : ''} ${isSidebarExpanded ? 'expanded' : ''}`} type="button" aria-label={t('allInboxes')} title={isSidebarExpanded ? undefined : t('allInboxes')} aria-current={isUnifiedInbox ? 'page' : undefined} onClick={selectUnifiedInbox}>
              <IconInbox aria-hidden="true" size={20} stroke={1.8} />
              {isSidebarExpanded ? <span className="account-button-copy"><strong>{t('allInboxes')}</strong><span>{t('allInboxesDescription')}</span></span> : null}
            </button> : null}
              <button className={`account-button account-add-rail-button ${isSidebarExpanded ? 'expanded' : ''}`} type="button" aria-label={t('addAccount')} title={isSidebarExpanded ? undefined : t('addAccount')} onClick={() => navigateToSettings(true)}>
              <IconMailPlus aria-hidden="true" size={19} stroke={1.8} />
              {isSidebarExpanded ? <span className="account-button-copy"><strong>{t('addAccount')}</strong><span>{t('addAccountDescription')}</span></span> : null}
            </button>
         </div> : null}
       </nav>
       {isNotificationCenterOpen ? <Suspense fallback={null}><NotificationCenter
         entries={notificationHistory}
         title={t('notificationCenter')}
         emptyLabel={t('notificationCenterEmpty')}
         clearLabel={t('clearNotificationHistory')}
         closeLabel={t('closeNotificationCenter')}
         openLabel={t('openNotification')}
         formatTime={(value) => formatMessageTime(new Date(value).toISOString(), settings, i18n.language)}
         onClear={() => setNotificationHistory([])}
         onClose={() => setIsNotificationCenterOpen(false)}
         onOpen={(entry) => {
           setIsNotificationCenterOpen(false)
           if (entry.destination) void openNotificationDestination(entry.destination).catch((error: unknown) => setToastMessage(getDisplayError(error)))
         }}
       /></Suspense> : null}
       <div className="sidebar-footer">
          <button className="sidebar-toggle" type="button" aria-expanded={isSidebarExpanded} aria-controls="account-rail-nav" aria-label={t(isSidebarExpanded ? 'collapseSidebar' : 'expandSidebar')} title={t(isSidebarExpanded ? 'collapseSidebar' : 'expandSidebar')} onClick={() => setIsSidebarExpanded((current) => !current)}>
            {isSidebarExpanded ? <IconChevronLeft aria-hidden="true" size={18} stroke={1.8} /> : <IconChevronRight aria-hidden="true" size={18} stroke={1.8} />}
            {isSidebarExpanded ? <span>{t('collapseSidebar')}</span> : null}
          </button>
         <button ref={settingsButtonRef} className={`settings-button ${activeView === 'settings' ? 'active' : ''}`} type="button" aria-label={t('settings')} title={t('settings')} aria-current={activeView === 'settings' ? 'page' : undefined} onClick={toggleSettings}>
           <IconSettings aria-hidden="true" size={18} stroke={1.8} />
           {isSidebarExpanded ? <span>{t('settings')}</span> : null}
         </button>
         {appLockConfigured ? <button className="settings-button app-lock-button" type="button" aria-label={t('lockApp')} title={t('lockApp')} onClick={lockApp}><IconLock aria-hidden="true" size={18} stroke={1.8} />{isSidebarExpanded ? <span>{t('lockApp')}</span> : null}</button> : null}
         <button className={`settings-button notification-center-button ${isNotificationCenterOpen ? 'active' : ''}`} type="button" aria-label={t('notificationCenter')} title={t('notificationCenter')} aria-expanded={isNotificationCenterOpen} onClick={() => setIsNotificationCenterOpen((current) => !current)}>
           <IconBell aria-hidden="true" size={18} stroke={1.8} />
           {isSidebarExpanded ? <span>{t('notificationCenter')}</span> : null}
           {notificationHistory.length > 0 ? <span className="notification-history-count" aria-label={t('notificationHistoryCount', { count: notificationHistory.length })}>{notificationHistory.length > 9 ? '9+' : notificationHistory.length}</span> : null}
         </button>
       </div>
      </aside>
      <section className={`content-area ${activeView === 'settings' ? 'settings-active' : ''} ${selectedMessage && activeView === 'mail' ? 'reader-open' : ''} ${shouldShowMobileReader && activeView === 'mail' ? 'mobile-reader-empty' : ''}`}>
        {activeView === 'mail' ? <div className="mail-workspace">
          <header className="mail-workspace-header">
            <div className="mail-workspace-heading">
              <div className="mail-workspace-title-group">
                <h1 id="mail-workspace-title">{activeFolder === 'inbox' ? t('inbox') : activeFolder === 'starred' ? t('starredMail') : t(activeFolder)}</h1>
                <span id="mail-account-status" aria-live="polite" dir={activeAccount ? 'ltr' : undefined}>{isLoadingAccounts ? t('loadingAccounts') : accountLoadError ? t('accountsUnavailable') : isUnifiedInbox ? t('allInboxes') : activeAccount?.address ?? t('noConnectedAccounts')}</span>
              </div>
              <div className="mail-workspace-actions">
                {activeSyncStatus !== 'idle' ? <span className={`mail-sync-status ${activeSyncStatus}`} role="status" aria-live="polite"><span className="mail-sync-status-dot" aria-hidden="true" />{t(activeSyncStatus === 'syncing' ? 'syncingMail' : 'syncFailed')}</span> : null}
                {activeAccount ? <Button className="mail-refresh-button" variant="ghost" size="icon" type="button" disabled={isRefreshing} aria-busy={isRefreshing} aria-label={t('refreshMail')} title={t('refreshMail')} onClick={() => { void refreshMailbox() }}><IconRefresh className={isRefreshing ? 'is-spinning' : undefined} aria-hidden="true" size={16} stroke={1.8} /></Button> : null}
                {activeAccount && activeProviderCapabilities?.can_send ? <Button className="compose-button" type="button" onClick={() => { void openComposer() }}><IconPencil aria-hidden="true" size={17} stroke={1.8} />{t('compose')}</Button> : null}
              </div>
            </div>
            <div className="mail-workspace-toolbar">
              <nav className="mail-folder-nav" aria-labelledby="mail-folders-label">
                <span className="mail-section-label" id="mail-folders-label">{t('mailFolders')}</span>
                <div className="mail-folder-options">
                  {[
                    { id: 'inbox' as const, label: t('inbox'), icon: IconInbox },
                    { id: 'sent' as const, label: t('sent'), icon: IconSend },
                    { id: 'spam' as const, label: t('spam'), icon: IconAlertTriangle },
                    { id: 'trash' as const, label: t('trash'), icon: IconTrash },
                  ].map((folder) => {
                    const Icon = folder.icon
                    const unreadCount = folderUnreadCounts[folder.id]
                    return <Button className={`folder-nav-item ${activeFolder === folder.id ? 'active' : ''}`} data-mail-folder={folder.id} key={folder.id} variant="ghost" type="button" disabled={!activeAccount} aria-describedby={!activeAccount ? 'mail-account-status' : undefined} aria-current={activeFolder === folder.id ? 'page' : undefined} onClick={() => selectMailFolder(folder.id)} onKeyDown={(event) => handleMailFolderKeyDown(event, folder.id)}><Icon aria-hidden="true" size={16} stroke={1.8} /><span>{folder.label}</span>{unreadCount && unreadCount > 0 ? <span className="folder-unread-count" aria-label={t('folderUnreadCount', { count: unreadCount })}>{unreadCount}</span> : null}</Button>
                  })}
                </div>
              </nav>
              <div className="mail-filters">
                <span className="mail-section-label" id="mail-filters-label">{t('mailFilters')}</span>
                <div className="mail-filter-options" role="group" aria-labelledby="mail-filters-label">
                  {(['unread', 'starred', 'attachments'] as const).map((filter) => (
                    <button className={`mail-filter ${activeFilter === filter ? 'active' : ''}`} data-mail-filter={filter} key={filter} type="button" disabled={!activeAccount} aria-describedby={!activeAccount ? 'mail-account-status' : undefined} aria-pressed={activeFilter === filter} tabIndex={activeAccount && (activeFilter === filter || (activeFilter === 'all' && filter === 'unread')) ? 0 : -1} onClick={() => selectMailFilter(filter)} onKeyDown={(event) => handleMailFilterKeyDown(event, filter)}>
                      {t(`${filter}Mail`)}
                    </button>
                  ))}
                  {activeFilter !== 'all' ? <button className="mail-filter mail-filter-clear" type="button" onClick={() => selectMailFilter(activeFilter)}>{t('clearFilter')}</button> : null}
                </div>
              </div>
              <div className="mail-view-controls" role="group" aria-label={t('mailViewOptions')}>
                <label className="mail-view-control">
                  <span>{t('sortMail')}</span>
                  <Select value={mailSort} disabled={!activeAccount} onValueChange={(value) => { if (MAIL_SORT_OPTIONS.includes(value as MailSort)) setMailSort(value as MailSort) }}>
                    <SelectTrigger className="mail-view-select" aria-label={t('sortMail')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">{t('sortNewest')}</SelectItem>
                      <SelectItem value="oldest">{t('sortOldest')}</SelectItem>
                      <SelectItem value="sender_asc">{t('sortSenderAsc')}</SelectItem>
                      <SelectItem value="sender_desc">{t('sortSenderDesc')}</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="mail-view-control">
                  <span>{t('density')}</span>
                  <Select value={settings.density} disabled={!activeAccount} onValueChange={(value) => { if (value === 'compact' || value === 'comfortable' || value === 'spacious') updateSetting('density', value as Density) }}>
                    <SelectTrigger className="mail-view-select mail-density-select" aria-label={t('density')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="compact">{t('compact')}</SelectItem>
                      <SelectItem value="comfortable">{t('comfortable')}</SelectItem>
                      <SelectItem value="spacious">{t('spacious')}</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            </div>
          </header>
          <div className={`mail-workspace-body ${selectedMessage ? 'reader-open' : shouldShowReaderState ? 'reader-state-open' : ''}`}>
            <section className="mail-list-pane" aria-labelledby="mail-workspace-title">
              {shouldShowMessageSelectionToolbar ? <div className="message-selection-toolbar" role="toolbar" aria-label={t('bulkMailActions')}>
                <div className="message-selection-summary">
                  <button className="message-selection-toggle" type="button" disabled={filteredMessages.length === 0} aria-pressed={allVisibleMessagesSelected} aria-label={allVisibleMessagesSelected ? t('deselectAllMessages') : t('selectAllMessages')} onClick={toggleAllMessageSelection}><span className={`message-selection-box ${allVisibleMessagesSelected ? 'checked' : ''}`} aria-hidden="true" /></button>
                  <span className="message-total-count" aria-live="polite">{t('mailCount', { count: filteredMessages.length })}</span>
                  {selectedVisibleMessageCount > 0 ? <span className="message-selection-count" aria-live="polite">{t('selectedMessages', { count: selectedVisibleMessageCount })}</span> : null}
                </div>
                <div className="message-selection-actions" role="group" aria-label={t('bulkMailActions')}>
                  <Button variant="ghost" size="icon" type="button" disabled={selectedVisibleMessageCount === 0 || bulkActionInFlight || !isBulkActionAvailable('archive')} aria-label={t('archive')} title={t('archive')} onClick={() => { void runBulkMessageAction('archive') }}><IconArchive aria-hidden="true" size={20} stroke={1.8} /></Button>
                  <Button variant="ghost" size="icon" type="button" disabled={selectedVisibleMessageCount === 0 || bulkActionInFlight || !isBulkActionAvailable('mark_read')} aria-label={t('markRead')} title={t('markRead')} onClick={() => { void runBulkMessageAction('mark_read') }}><IconMail aria-hidden="true" size={20} stroke={1.8} /></Button>
                  <Button variant="ghost" size="icon" type="button" disabled={selectedVisibleMessageCount === 0 || bulkActionInFlight || !isBulkActionAvailable('mark_unread')} aria-label={t('markUnread')} title={t('markUnread')} onClick={() => { void runBulkMessageAction('mark_unread') }}><IconMail aria-hidden="true" size={20} stroke={1.8} /></Button>
                  <Button variant="ghost" size="icon" type="button" disabled={selectedVisibleMessageCount === 0 || bulkActionInFlight || !isBulkActionAvailable('trash')} aria-label={t('delete')} title={t('delete')} onClick={() => { void runBulkMessageAction('trash') }}><IconTrash aria-hidden="true" size={20} stroke={1.8} /></Button>
                  <Button variant="ghost" size="icon" type="button" disabled={selectedVisibleMessageCount === 0 || bulkActionInFlight} aria-label={t('cancel')} title={t('cancel')} onClick={clearBulkSelection}><IconX aria-hidden="true" size={20} stroke={1.8} /></Button>
                </div>
              </div> : null}
              <div ref={messageListRef} className="message-list" aria-busy={isLoadingAccounts || isLoadingFolder || isLoadingMessages}>
                {!selectedMessage && filteredMessages.length > 0 ? <div className="message-list-column-header" aria-hidden="true">
                  <span />
                  <span>{t('messageSender')}</span>
                  <span />
                  <span>{t('subject')}</span>
                  <span>{t('messageReceived')}</span>
                  <span />
                </div> : null}
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
                ) : displayedMessageRows.length > 0 ? displayedMessageRows.map((message) => (
                  <MailRow key={message.messageKey} message={message} selected={selectedMessageId === message.messageKey} selectionChecked={selectedMessageIds.has(message.messageKey)} unreadLabel={t('unreadMail')} isStarDisabled={!isActionAvailable(message.starred ? 'unstar' : 'star', message.account_id ?? activeAccountId)} onSelect={stableSelectMessage} onToggleSelection={toggleMessageSelection} onToggleStar={stableStarMessage} onContextMenu={stableHandleMailContextMenu} onKeyDown={stableHandleMailRowKeyDown} />
                )) : (
                  <MailListEmptyState icon={emptyListIcon} title={emptyListCopy.title} description={emptyListCopy.description} />
                )}
                {visibleNextPageToken || hasUnifiedNextPage ? <span ref={loadMoreSentinelRef} className="message-load-sentinel" aria-hidden="true" /> : null}
              </div>
              {visibleNextPageToken || hasUnifiedNextPage ? <Button className="load-more-button" variant="ghost" type="button" disabled={isLoadingMore} onClick={() => loadNextPage()}>{isLoadingMore ? t('loadingMoreMail') : t('loadMoreMail')}</Button> : null}
            </section>
            <section ref={mainCanvasRef} className="main-canvas" aria-label={selectedMessage ? undefined : t('mainCanvas')} aria-labelledby={selectedMessage ? 'reader-message-subject' : undefined} onScroll={handleReaderScroll}>
          {selectedMessage ? (
            <Suspense fallback={<div className="reader-empty reader-empty-loading" role="status" aria-label={t('loadingMail')}><div className="reader-loading reader-empty-loading-content"><Skeleton className="reader-loading-line reader-loading-line-wide" /><Skeleton className="reader-loading-line" /><Skeleton className="reader-loading-line reader-loading-line-short" /></div></div>}>
            <article className="mail-reader">
              <ReaderToolbar labels={{ toolbarLabel: t('messageToolbar'), archive: activeFolder === 'trash' ? t('restore') : activeFolder === 'spam' ? t('notSpam') : t('archive'), delete: t('delete'), markUnread: t('markUnread'), reply: t('reply'), backToMailList: t('backToMailList') }} backButtonRef={readerBackButtonRef} disabled={messageActionInFlightId === selectedMessageKey} disabledActions={{ archive: !isActionAvailable(readerArchiveAction, selectedMessageAccount?.id ?? activeAccountId), delete: !isActionAvailable(readerDeleteAction, selectedMessageAccount?.id ?? activeAccountId), markUnread: !isActionAvailable('mark_unread', selectedMessageAccount?.id ?? activeAccountId), reply: !selectedMessageCapabilities?.can_reply }} onBack={closeReader} onArchive={() => selectedMessageKey ? activeFolder === 'trash' || activeFolder === 'spam' ? restoreMessage(selectedMessageKey) : requestArchiveMessage(selectedMessageKey) : undefined} onDelete={() => { if (selectedMessageKey) requestDeleteMessage(selectedMessageKey) }} onMarkUnread={() => { if (selectedMessageKey) markMessageUnread(selectedMessageKey) }} onReply={openReply} />
              <header className={`reader-header ${isReaderScrolled ? 'is-compact' : ''}`}>
                <div className="reader-title-row">
                  <h2 id="reader-message-subject" title={selectedMessageSubject}>{selectedMessageSubject}</h2>
                  <Button className={`reader-star ${selectedMessage.starred ? 'active' : ''}`} variant="ghost" size="icon" type="button" aria-label={t('starMail')} title={t('starMail')} aria-pressed={selectedMessage.starred} disabled={!isActionAvailable(selectedMessage.starred ? 'unstar' : 'star', selectedMessageAccount?.id ?? activeAccountId)} onClick={() => { if (selectedMessageKey) starMessage(selectedMessageKey) }}>
                    <IconStar aria-hidden="true" size={18} stroke={1.8} fill={selectedMessage.starred ? 'currentColor' : 'none'} />
                  </Button>
                </div>
                <div className="reader-meta">
                  <SenderAvatar className="reader-avatar" label={selectedMessageSender} address={selectedMessage.address} imageUrl={selectedMessage.avatar_url} />
                  <div>
                    <strong dir="auto">{selectedMessageSender}</strong>
                    <button className="reader-details-toggle" type="button" aria-expanded={isReaderDetailsOpen} aria-controls="reader-details" onClick={() => setIsReaderDetailsOpen((current) => !current)}>
                      {t(isReaderDetailsOpen ? 'hideDetails' : 'showDetails')}<IconChevronDown aria-hidden="true" size={14} stroke={1.8} />
                    </button>
                     {isReaderDetailsOpen ? <div className="reader-details" id="reader-details">
                       <span><small>{t('from')}</small><span dir="ltr">{selectedMessage.address}</span></span>
                       {selectedMessageRecipients ? <span><small>{t('to')}</small><span dir="ltr">{selectedMessageRecipients}</span></span> : null}
                       {selectedMessage?.cc?.length ? <span><small>{t('cc')}</small><span dir="ltr">{selectedMessage.cc.join(', ')}</span></span> : null}
                       {selectedMessage?.bcc?.length ? <span><small>{t('bcc')}</small><span dir="ltr">{selectedMessage.bcc.join(', ')}</span></span> : null}
                       {selectedMessage?.reply_to?.length ? <span><small>{t('replyTo')}</small><span dir="ltr">{selectedMessage.reply_to.join(', ')}</span></span> : null}
                       {selectedMessage.message_id_header ? <span><small>{t('messageId')}</small><span dir="ltr">{selectedMessage.message_id_header}</span></span> : null}
                     </div> : null}
                  </div>
                  <time dateTime={selectedMessage.time}>{selectedMessageTime}</time>
                </div>
              </header>
              <div className="reader-body" aria-busy={loadingMessageId === selectedMessageKey}>
                {loadingMessageId === selectedMessageKey ? (
                  <div className="reader-loading" role="status" aria-label={t('loadingMail')}>
                    <Skeleton className="reader-loading-line reader-loading-line-wide" />
                    <Skeleton className="reader-loading-line" />
                    <Skeleton className="reader-loading-line reader-loading-line-short" />
                  </div>
                ) : messageLoadErrorId === selectedMessageKey ? (
                  <div className="reader-error" role="alert"><strong>{t('messageLoadFailed')}</strong><span>{t('messageLoadFailedDescription')}</span><Button variant="ghost" type="button" onClick={() => { if (selectedMessageKey) retryMessageLoad(selectedMessageKey) }}>{t('tryAgain')}</Button></div>
                ) : selectedMessage.body_html ? <MailHtml html={selectedMessage.body_html} title={t('mailContent')} fontScale={settings.readerFontScale} onLinkClick={handleReaderLinkClick} /> : selectedMessage.body ? <p className="reader-plain-text" dir="auto">{selectedMessage.body}</p> : <p className="reader-no-content">{t('messageContentUnavailable')}</p>}
                {selectedMessage.attachments?.length ? <section className="reader-attachments" aria-labelledby="reader-attachments-title">
                  <h3 id="reader-attachments-title"><IconPaperclip aria-hidden="true" size={16} stroke={1.8} />{t('attachments')}</h3>
                  <div className="attachment-list">
                    {selectedMessage.attachments.map((attachment) => <Button key={attachment.id} className="attachment-button" variant="ghost" type="button" disabled={downloadingAttachmentId !== null} onClick={() => downloadAttachment(attachment)}>
                      <span className="attachment-name"><IconPaperclip aria-hidden="true" size={15} stroke={1.8} /><span>{attachment.filename}</span></span>
                      <span className="attachment-size">{formatFileSize(attachment.size, i18n.language)}</span>
                      <IconDownload aria-hidden="true" size={15} stroke={1.8} />
                    </Button>)}
                  </div>
                </section> : null}
                {threadMessages.filter((message) => getMessageIdentity(message, selectedMessageAccount?.id ?? activeAccountId) !== selectedMessageKey).length > 0 ? <section className="thread-history" aria-labelledby="thread-history-title">
                  <div className="thread-history-heading"><h3 id="thread-history-title">{t('conversation')}</h3><span>{t('threadMessageCount', { count: threadMessages.length })}</span></div>
                  {threadMessages.filter((message) => getMessageIdentity(message, selectedMessageAccount?.id ?? activeAccountId) !== selectedMessageKey).map((message) => {
                    const messageKey = getMessageIdentity(message, selectedMessageAccount?.id ?? activeAccountId)
                    return <ThreadMessageCard key={messageKey} sender={message.sender} address={message.address} avatarUrl={message.avatar_url} time={formatMessageTime(message.time, settings, i18n.language)} dateTime={message.time} recipient={selectedMessageAccount?.address ?? ''} attachments={message.attachments ?? []} downloadingAttachmentId={downloadingAttachmentId} unread={message.unread} starred={message.starred} archiveLabel={activeFolder === 'spam' ? t('notSpam') : activeFolder === 'trash' ? t('restore') : t('archive')} body={message.body} bodyHtml={message.body_html} fontScale={settings.readerFontScale} onLinkClick={handleReaderLinkClick} onDownloadAttachment={(attachment) => downloadAttachment(attachment, messageKey)} onToggleStar={() => starMessage(messageKey)} onToggleRead={() => { if (message.unread) markMessageRead(messageKey); else markMessageUnread(messageKey) }} onArchive={() => activeFolder === 'spam' || activeFolder === 'trash' ? restoreMessage(messageKey) : requestArchiveMessage(messageKey)} onDelete={() => requestDeleteMessage(messageKey)} disabledActions={{ star: !isActionAvailable(message.starred ? 'unstar' : 'star', message.account_id ?? selectedMessageAccount?.id ?? activeAccountId), markRead: !isActionAvailable(message.unread ? 'mark_read' : 'mark_unread', message.account_id ?? selectedMessageAccount?.id ?? activeAccountId), archive: !isActionAvailable(readerArchiveAction, message.account_id ?? selectedMessageAccount?.id ?? activeAccountId), delete: !isActionAvailable(readerDeleteAction, message.account_id ?? selectedMessageAccount?.id ?? activeAccountId), reply: !providerCapabilitiesByAccount[message.account_id ?? selectedMessageAccount?.id ?? activeAccountId]?.can_reply }} onReply={() => {
                      setSelectedMessageId(messageKey)
                      const messageAccountId = message.account_id ?? selectedMessageAccount?.id ?? activeAccountId
                      loadedThreadIdRef.current = message.thread_id && messageAccountId ? `${messageAccountId}:${message.thread_id}` : null
                      setIsReaderDetailsOpen(false)
                      setIsReplying(true)
                      setReplyDraft('')
                    }} />
                  })}
                </section> : null}
                {isReplying ? <ReplyComposer value={replyDraft} onChange={setReplyDraft} onCancel={cancelReply} onSubmit={submitReply} isSubmitting={isSendingReply} /> : null}
              </div>
            </article>
            </Suspense>
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
            <EmptyState icon={accounts.length === 0 ? 'account' : 'mail'} title={accounts.length === 0 ? t('connectAccount') : t('noMailSelected')} description={accounts.length === 0 ? t('connectAccountDescription') : t('noMailSelectedDescription')} actionLabel={accounts.length === 0 ? t('addAccount') : undefined} actionHasPopup={accounts.length === 0 ? 'dialog' : undefined} onAction={accounts.length === 0 ? () => navigateToSettings(true) : undefined} />
          )}
            </section>
          </div>
        </div> : null}
        {activeView === 'settings' ? <section className="settings-page" aria-labelledby="settings-title"><Suspense fallback={<div className="settings-loading" role="status">{t('loadingMailbox')}</div>}><SettingsPanel settings={settings} onChange={updateSetting} accounts={accounts} providerLogos={providerLogos} defaultAccountId={defaultAccountId} onSetDefault={setDefaultAccount} onRemoveAccount={removeAccount} onStartAuth={startAuth} onError={(error: unknown) => setToastMessage(getDisplayError(error))} onBackToMail={() => { invalidateLoadMore(); setOpenAddAccount(false); setActiveView('mail'); clearSearch(); window.requestAnimationFrame(() => settingsButtonRef.current?.focus()) }} isAddAccountOpen={openAddAccount} onAddAccountOpenChange={setOpenAddAccount} isAccountMutationInFlight={isAccountMutationInFlight} notificationPermission={notificationPermission} onRequestNotificationPermission={requestNotificationPermission} appLockConfigured={appLockConfigured} onConfigureAppLock={configureAppLock} onDisableAppLock={disableAppLock} onExportBackup={exportBackup} onImportBackup={importBackup} appVersion={appVersion} updateState={updateState} updateAvailableVersion={updateAvailableVersion} updateProgress={updateProgress} onCheckForUpdates={() => checkForUpdates()} onInstallUpdate={installUpdate} /></Suspense></section> : null}
      </section>
      {isComposing ? <section className="compose-page" aria-labelledby="compose-title">
        <header className="compose-page-header">
          <h1 id="compose-title">{t('newMessage')}</h1>
          {draftStatus !== 'idle' ? <span className="compose-draft-status" role="status">{t(draftStatus === 'saving' ? 'draftSaving' : 'draftSaved')}</span> : null}
          <div className="compose-header-actions">
            <Button variant="ghost" size="icon" type="button" aria-label={t('drafts')} title={t('drafts')} aria-expanded={isDraftsPanelOpen} onClick={() => { setIsDraftsPanelOpen((current) => !current); refreshComposeDrafts() }} disabled={isSendingMessage}><IconFileText aria-hidden="true" size={17} stroke={1.8} /></Button>
            {isDraftsPanelOpen ? <Suspense fallback={null}><DraftsPanel drafts={composeDrafts} currentDraftId={composeDraftId} canSave={[composeRecipient, composeCc, composeBcc, composeSubject, composeBody].some((value) => value.trim().length > 0) || composeAttachments.length > 0} isSaving={draftStatus === 'saving'} isLoading={isLoadingDrafts} formatTime={(value) => formatMessageTime(value, settings, i18n.language)} title={t('drafts')} savingLabel={t('draftSaving')} loadingLabel={t('draftLoading')} saveLabel={t('saveDraft')} emptyLabel={t('noDrafts')} untitledLabel={t('untitledDraft')} noRecipientsLabel={t('noRecipients')} deleteLabel={t('deleteDraft')} onSave={() => { void saveCurrentComposeDraft() }} onSelect={(draft) => { void selectComposeDraft(draft) }} onDelete={(draft) => { void deleteComposeDraft(draft) }} /></Suspense> : null}
            <Button variant="ghost" size="icon" type="button" aria-label={t('scheduledMessages')} title={t('scheduledMessages')} aria-expanded={isScheduledMessagesPanelOpen} onClick={() => { setIsScheduledMessagesPanelOpen((current) => !current); void refreshScheduledMessages() }} disabled={isSendingMessage}><IconClock aria-hidden="true" size={17} stroke={1.8} /></Button>
            {isScheduledMessagesPanelOpen ? <Suspense fallback={null}><ScheduledMessagesPanel messages={scheduledMessages} title={t('scheduledMessages')} emptyLabel={t('noScheduledMessages')} cancelLabel={t('cancelScheduledMessage')} formatTime={(value) => formatMessageTime(new Date(value).toISOString(), settings, i18n.language)} onCancel={(message) => { void cancelScheduledMessage(message) }} /></Suspense> : null}
          </div>
          <Button variant="ghost" size="icon" type="button" aria-label={t('closeDialog')} title={t('closeDialog')} onClick={closeComposer} disabled={isSendingMessage || draftStatus === 'saving'}><IconX aria-hidden="true" size={18} stroke={1.8} /></Button>
        </header>
        <Suspense fallback={<div className="settings-loading" role="status">{t('loadingMailbox')}</div>}><ComposeForm senderAddress={composeAccount?.address ?? ''} recipient={composeRecipient} cc={composeCc} bcc={composeBcc} subject={composeSubject} body={composeBody} bodyHtml={composeBodyHtml} scheduleAt={composeScheduleAt} attachments={composeAttachments} attachmentLimits={composeAttachmentLimits} isSending={isSendingMessage} isDraftSaving={draftStatus === 'saving'} savedRecipients={savedRecipients} onSaveRecipient={saveComposeRecipient} onRecipientChange={updateComposeRecipient} onCcChange={updateComposeCc} onBccChange={updateComposeBcc} onSubjectChange={updateComposeSubject} onBodyChange={updateComposeBody} onBodyHtmlChange={updateComposeBodyHtml} onScheduleAtChange={(value) => { setComposeScheduleAt(value); markComposeDirty() }} onAttachmentsChange={updateComposeAttachments} onCancel={closeComposer} onSubmit={submitMessage} /></Suspense>
      </section> : null}
      {activeView === 'mail' && activeAccount && activeProviderCapabilities?.can_send && !isComposing ? <Button className="floating-compose-button" size="icon" type="button" aria-label={t('compose')} title={t('compose')} onClick={() => { void openComposer() }}><IconPencil aria-hidden="true" size={19} stroke={1.8} /></Button> : null}
       {contextMenu ? <Suspense fallback={null}><MailContextMenu x={contextMenu.x} y={contextMenu.y} menuLabel={t('mailActions')} disabled={messageActionInFlightId !== null} disabledActions={{ markUnread: !isActionAvailable((contextMessage?.unread ?? false) ? 'mark_read' : 'mark_unread', contextMessage?.account_id ?? activeAccountId), star: !isActionAvailable((contextMessage?.starred ?? false) ? 'unstar' : 'star', contextMessage?.account_id ?? activeAccountId), spam: !isActionAvailable('spam', contextMessage?.account_id ?? activeAccountId), archive: !isActionAvailable(readerArchiveAction, contextMessage?.account_id ?? activeAccountId), delete: !isActionAvailable(readerDeleteAction, contextMessage?.account_id ?? activeAccountId) }} showSpam={activeFolder !== 'spam' && activeFolder !== 'trash'} returnFocusElement={contextMenu.returnFocusElement} labels={{ markUnread: (contextMessage?.unread ?? false) ? t('markRead') : t('markUnread'), star: t('starMail'), archive: activeFolder === 'trash' ? t('restore') : activeFolder === 'spam' ? t('notSpam') : t('archive'), delete: t('delete'), reportSpam: t('reportSpam') }} onClose={() => setContextMenu(null)} onMarkUnread={() => { if (contextMessage?.unread) markMessageReadFromContext(contextMenu.messageId); else markMessageUnread(contextMenu.messageId) }} onStar={() => starMessage(contextMenu.messageId)} onSpam={() => moveMessageToSpam(contextMenu.messageId)} onArchive={() => activeFolder === 'trash' || activeFolder === 'spam' ? restoreMessage(contextMenu.messageId) : requestArchiveMessage(contextMenu.messageId)} onDelete={() => requestDeleteMessage(contextMenu.messageId)} /></Suspense> : null}
      <Dialog open={pendingArchiveId !== null} title={t('confirmArchiveTitle')} closeLabel={t('closeDialog')} onClose={cancelArchiveMessage}>
        <div className="confirm-dialog-content"><p>{t('confirmArchiveDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" onClick={cancelArchiveMessage}>{t('cancel')}</Button><Button onClick={confirmArchiveMessage}>{t('archive')}</Button></div></div>
      </Dialog>
      <Dialog open={pendingDeleteId !== null} title={t('confirmDeleteTitle')} closeLabel={t('closeDialog')} onClose={cancelDeleteMessage}>
        <div className="confirm-dialog-content"><p>{t('confirmDeleteDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" onClick={cancelDeleteMessage}>{t('cancel')}</Button><Button variant="danger" onClick={() => confirmDeleteMessage()}>{t('delete')}</Button></div></div>
      </Dialog>
       <Dialog open={pendingPermanentDeleteId !== null} title={t('confirmPermanentDeleteTitle')} closeLabel={t('closeDialog')} onClose={cancelPermanentDeleteMessage}>
         <div className="confirm-dialog-content"><p>{t('confirmPermanentDeleteDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" onClick={cancelPermanentDeleteMessage}>{t('cancel')}</Button><Button variant="danger" onClick={() => { if (pendingPermanentDeleteId) permanentlyDeleteMessage(pendingPermanentDeleteId) }}>{t('delete')}</Button></div></div>
       </Dialog>
       <Dialog open={isAccountSwitcherOpen} title={t('switchAccount')} closeLabel={t('closeDialog')} onClose={() => setIsAccountSwitcherOpen(false)}>
         <div className="account-switcher-list">
           {accounts.map((account) => <button className={`account-switcher-option ${account.id === activeAccountId && !isUnifiedInbox ? 'active' : ''}`} key={account.id} type="button" onClick={() => { setIsAccountSwitcherOpen(false); selectAccount(account.id) }}>
             <img src={providerLogos[account.provider]} alt="" aria-hidden="true" />
             <span><strong>{t(account.provider)}</strong><span dir="ltr">{account.address}</span></span>
           </button>)}
           {accounts.length > 1 ? <button className={`account-switcher-option ${isUnifiedInbox ? 'active' : ''}`} type="button" onClick={() => { setIsAccountSwitcherOpen(false); selectUnifiedInbox() }}>
             <IconInbox aria-hidden="true" size={19} stroke={1.8} />
             <span><strong>{t('allInboxes')}</strong><span>{t('allInboxesDescription')}</span></span>
           </button> : null}
         </div>
       </Dialog>
       <Dialog open={isCommandPaletteOpen} title={t('commandPalette')} closeLabel={t('closeDialog')} onClose={() => setIsCommandPaletteOpen(false)}>
         <div className="command-palette-content">
           <p>{t('commandPaletteDescription')}</p>
           <div className="command-palette-list" role="list">
             {activeProviderCapabilities?.can_send ? <button type="button" role="listitem" onClick={() => { setIsCommandPaletteOpen(false); void openComposer() }}><span>{t('compose')}</span><kbd>C</kbd></button> : null}
             {activeAccount ? <button type="button" role="listitem" onClick={() => { setIsCommandPaletteOpen(false); void refreshMailbox() }}><span>{t('refreshMail')}</span><kbd>F5</kbd></button> : null}
             <button type="button" role="listitem" onClick={() => { setIsCommandPaletteOpen(false); selectMailFolder('inbox') }}><span>{t('inbox')}</span><kbd>G I</kbd></button>
             <button type="button" role="listitem" onClick={() => { setIsCommandPaletteOpen(false); selectMailFolder('sent') }}><span>{t('sent')}</span><kbd>G S</kbd></button>
             <button type="button" role="listitem" onClick={() => { setIsCommandPaletteOpen(false); setIsNotificationCenterOpen(true) }}><span>{t('notificationCenter')}</span><kbd>N</kbd></button>
             {accounts.length > 0 ? <button type="button" role="listitem" onClick={() => { setIsCommandPaletteOpen(false); setIsAccountSwitcherOpen(true) }}><span>{t('switchAccount')}</span><kbd>Ctrl+Shift+A</kbd></button> : null}
             <button type="button" role="listitem" onClick={() => { setIsCommandPaletteOpen(false); navigateToSettings() }}><span>{t('settings')}</span><kbd>Ctrl+,</kbd></button>
           </div>
         </div>
       </Dialog>
       <Dialog open={isComposeCloseConfirmationOpen} title={t('closeComposerTitle')} closeLabel={t('closeDialog')} onClose={cancelComposeCloseConfirmation}>
        <div className="confirm-dialog-content"><p>{t('closeComposerDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" type="button" onClick={cancelComposeCloseConfirmation}>{t('cancel')}</Button><Button variant="danger" type="button" disabled={isSendingMessage || draftStatus === 'saving'} onClick={() => { void discardComposer() }}>{t('discardDraft')}</Button><Button type="button" disabled={draftStatus === 'saving'} onClick={() => { void saveAndCloseComposer() }}>{t('saveDraft')}</Button></div></div>
      </Dialog>
      <Dialog open={isCloseConfirmationOpen} title={t('confirmCloseTitle')} closeLabel={t('closeDialog')} onClose={() => setIsCloseConfirmationOpen(false)}>
        <div className="confirm-dialog-content"><p>{t('confirmCloseDescription')}</p><div className="confirm-dialog-actions"><Button variant="ghost" type="button" onClick={() => setIsCloseConfirmationOpen(false)}>{t('cancel')}</Button><Button type="button" onClick={minimizeWindowToTray}><IconMinus aria-hidden="true" size={15} stroke={1.8} />{t('minimizeToTrayNow')}</Button><Button variant="danger" type="button" onClick={confirmWindowClose}>{t('close')}</Button></div></div>
      </Dialog>
      <Toast open={toastMessage.length > 0} action={undoableMessageAction ? <button className="toast-action" type="button" onClick={() => { void undoLastMessageAction() }}>{t('undo')}</button> : undefined}>{toastMessage}</Toast>
      {isAppLocked ? <section className="app-lock-overlay" aria-labelledby="app-lock-title"><div className="app-lock-card"><IconLock aria-hidden="true" size={28} stroke={1.8} /><h1 id="app-lock-title">{t('appLocked')}</h1><p>{t('appLockedDescription')}</p><form onSubmit={(event) => { event.preventDefault(); void unlockApp() }}><Input type="password" autoFocus value={appLockPin} onChange={(event) => setAppLockPin(event.target.value)} placeholder={t('appLockPinPlaceholder')} autoComplete="off" /><Button type="submit" disabled={!appLockPin}>{t('unlockApp')}</Button></form></div></section> : null}
    </main>
  )
}

export default App
