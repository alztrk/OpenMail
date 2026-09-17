import { useEffect, useRef, type KeyboardEvent } from 'react'
import { IconAlertTriangle, IconSearch } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { getSenderLabel } from '@/lib/mail'
import { SenderAvatar } from '@/components/mail/sender-avatar'

type SearchAccount = {
  id: string
  address: string
  provider: 'gmail' | 'outlook'
}

type SearchMessage = {
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
  attachments?: Array<{ id: string; filename: string; mime_type: string; size: number }>
}

export type MailSearchResult = {
  account: SearchAccount
  message: SearchMessage
}

type MailSearchDialogProps = {
  results: MailSearchResult[]
  isSearching: boolean
  hasError: boolean
  hasPartialError: boolean
  activeIndex: number
  hasMore: boolean
  isLoadingMore: boolean
  providerLogos: Record<SearchAccount['provider'], string>
  labels: {
    title: string
    resultCount: (count: number) => string
    searching: string
    noResults: string
    noResultsDescription: string
    searchFailed: string
    searchFailedDescription: string
    tryAgain: string
    partialError: string
    loadMore: string
    loadingMore: string
    unread: string
    noSubject: string
  }
  formatTime: (value: string) => string
  onClose: (restoreFocus?: boolean) => void
  onRetry: () => void
  onSelect: (result: MailSearchResult) => void
  onHighlight: (index: number) => void
  onLoadMore: (source?: 'auto' | 'manual') => void
}

function getResultSenderLabel(result: MailSearchResult): string {
  return getSenderLabel(result.message.sender, result.message.address)
}

function getResultLabel(result: MailSearchResult, unreadLabel: string, noSubjectLabel: string): string {
  const unreadPrefix = result.message.unread ? `${unreadLabel}, ` : ''
  return `${unreadPrefix}${getResultSenderLabel(result)}: ${result.message.subject || noSubjectLabel}, ${result.account.address}`
}

export function MailSearchDialog({ results, isSearching, hasError, hasPartialError, activeIndex, hasMore, isLoadingMore, providerLogos, labels, formatTime, onClose, onRetry, onSelect, onHighlight, onLoadMore }: MailSearchDialogProps) {
  const resultListRef = useRef<HTMLDivElement>(null)
  const loadMoreSentinelRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!hasMore || results.length === 0 || isLoadingMore) return
    const list = resultListRef.current
    const sentinel = loadMoreSentinelRef.current
    if (!list || !sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore('auto')
    }, { root: list, rootMargin: '160px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore, onLoadMore, results.length])

  const moveResultFocus = (nextIndex: number) => {
    onHighlight(nextIndex)
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-search-result-index="${nextIndex}"]`)?.focus()
    })
  }

  const handleResultKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose(true)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveResultFocus((index + 1) % results.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveResultFocus((index - 1 + results.length) % results.length)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      moveResultFocus(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      moveResultFocus(results.length - 1)
    }
  }

  return <div className="search-results-dialog" id="search-results-dialog" role="dialog" aria-modal="false" aria-labelledby="search-results-title" data-search-surface>
    <div className="search-dialog-heading">
      <h2 id="search-results-title">{labels.title}</h2>
      {results.length > 0 ? <span className="search-dialog-count" aria-live="polite">{labels.resultCount(results.length)}</span> : null}
    </div>
    {hasPartialError ? <div className="search-dialog-partial-error" role="status"><IconAlertTriangle aria-hidden="true" size={14} stroke={1.8} /><span>{labels.partialError}</span></div> : null}
    {isSearching && results.length === 0 ? <div className="search-dialog-state" role="status"><IconSearch className="is-spinning" aria-hidden="true" size={18} stroke={1.8} /><strong>{labels.searching}</strong></div> : hasError ? <div className="search-dialog-state" role="alert"><IconAlertTriangle aria-hidden="true" size={18} stroke={1.8} /><strong>{labels.searchFailed}</strong><span>{labels.searchFailedDescription}</span><Button variant="ghost" type="button" onClick={onRetry}>{labels.tryAgain}</Button></div> : !isSearching && results.length === 0 ? <div className="search-dialog-state"><IconSearch aria-hidden="true" size={18} stroke={1.8} /><strong>{labels.noResults}</strong><span>{labels.noResultsDescription}</span></div> : results.length > 0 ? <div ref={resultListRef} className="search-result-list" role="list" aria-label={labels.title}>
      {results.map((result, index) => <div key={`${result.account.id}:${result.message.id}`} role="listitem">
        <button className={`search-result ${index === activeIndex ? 'active' : ''} ${result.message.unread ? 'unread' : ''}`} data-search-result-index={index} type="button" aria-current={index === activeIndex ? 'true' : undefined} aria-label={getResultLabel(result, labels.unread, labels.noSubject)} onClick={() => onSelect(result)} onFocus={() => onHighlight(index)} onKeyDown={(event) => handleResultKeyDown(event, index)}>
          <SenderAvatar className="search-result-avatar" label={getResultSenderLabel(result)} address={result.message.address} imageUrl={result.message.avatar_url} loading="lazy" />
          <span className="search-result-content">
            <span className="search-result-topline">
              <span className="search-result-identity">
                <strong dir="auto">{getResultSenderLabel(result)}</strong>
                <span className="search-result-account" dir="ltr"><img src={providerLogos[result.account.provider]} alt="" aria-hidden="true" /><span className="search-result-account-address">{result.account.address}</span></span>
              </span>
              <time dateTime={result.message.time}>{formatTime(result.message.time)}</time>
            </span>
            <span className="search-result-subject" dir="auto">{result.message.subject || labels.noSubject}</span>
            {result.message.preview ? <span className="search-result-preview" dir="auto">{result.message.preview}</span> : null}
          </span>
        </button>
      </div>)}
      {hasMore ? <span ref={loadMoreSentinelRef} className="search-load-sentinel" aria-hidden="true" /> : null}
    </div> : null}
    {hasMore && results.length > 0 ? <div className="search-dialog-more"><Button variant="ghost" type="button" disabled={isLoadingMore} onClick={() => onLoadMore('manual')}>{isLoadingMore ? labels.loadingMore : labels.loadMore}</Button></div> : null}
  </div>
}
