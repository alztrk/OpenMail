import { IconSend } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type ReplyComposerProps = {
  value: string
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void | Promise<void>
  isSubmitting?: boolean
}

export function ReplyComposer({ value, onChange, onCancel, onSubmit, isSubmitting = false }: ReplyComposerProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus({ preventScroll: true })
    textarea.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    })
  }, [])

  return (
    <form className="reply-composer" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void onSubmit() }}>
      <label htmlFor="reply-message">{t('replyDraft')}</label>
      <Textarea ref={textareaRef} id="reply-message" value={value} onChange={(event) => onChange(event.target.value)} placeholder={t('replyPlaceholder')} rows={5} />
      <div className="reply-composer-actions">
        <Button variant="ghost" type="button" onClick={onCancel}>{t('cancel')}</Button>
        <Button type="submit" disabled={!value.trim() || isSubmitting}><IconSend aria-hidden="true" size={15} stroke={1.8} />{t('send')}</Button>
      </div>
    </form>
  )
}
