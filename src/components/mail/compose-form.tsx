import { IconBold, IconClock, IconItalic, IconLink, IconList, IconPencil, IconUnderline } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { areValidEmailAddresses } from '@/lib/utils'
import { sanitizeComposeHtml } from '@/lib/compose-html'
import { RecipientInput, type SavedRecipient } from '@/components/mail/recipient-input'
import { AttachmentDropzone, type ComposeAttachment } from '@/components/mail/attachment-dropzone'

type ComposeFormProps = {
  senderAddress: string
  recipient: string
  cc: string
  bcc: string
  subject: string
  body: string
  bodyHtml: string
  scheduleAt: string
  attachments: ComposeAttachment[]
  attachmentLimits: { maxFileSize: number; maxTotalSize: number }
  isSending: boolean
  isDraftSaving: boolean
  onRecipientChange: (value: string) => void
  onCcChange: (value: string) => void
  onBccChange: (value: string) => void
  onSubjectChange: (value: string) => void
  onBodyChange: (value: string) => void
  onBodyHtmlChange: (value: string) => void
  onScheduleAtChange: (value: string) => void
  onAttachmentsChange: (attachments: ComposeAttachment[]) => void
  savedRecipients: SavedRecipient[]
  onSaveRecipient: (email: string) => void
  onCancel: () => void
  onSubmit: (attachments: ComposeAttachment[]) => void | Promise<void>
}

export function ComposeForm({
  senderAddress,
  recipient,
  cc,
  bcc,
  subject,
  body,
  bodyHtml,
  scheduleAt,
  attachments,
  attachmentLimits,
  isSending,
  isDraftSaving,
  onRecipientChange,
  onCcChange,
  onBccChange,
  onSubjectChange,
  onBodyChange,
  onBodyHtmlChange,
  onScheduleAtChange,
  onAttachmentsChange,
  savedRecipients,
  onSaveRecipient,
  onCancel,
  onSubmit,
}: ComposeFormProps) {
  const { t } = useTranslation()
  const hasInvalidRecipient = recipient.trim().length > 0 && !areValidEmailAddresses(recipient)
  const hasInvalidCc = cc.trim().length > 0 && !areValidEmailAddresses(cc)
  const hasInvalidBcc = bcc.trim().length > 0 && !areValidEmailAddresses(bcc)
  const canSubmit = areValidEmailAddresses(recipient) && !hasInvalidCc && !hasInvalidBcc && subject.trim().length > 0 && body.trim().length > 0
  const [isCcOpen, setIsCcOpen] = useState(false)
  const [isBccOpen, setIsBccOpen] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const sanitizedBodyHtml = sanitizeComposeHtml(bodyHtml)
    if (editor.innerHTML !== sanitizedBodyHtml) editor.innerHTML = sanitizedBodyHtml
    if (sanitizedBodyHtml !== bodyHtml) onBodyHtmlChange(sanitizedBodyHtml)
  }, [bodyHtml, onBodyHtmlChange])

  const applyFormat = (command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'createLink') => {
    if (command === 'createLink') {
      const url = window.prompt(t('linkUrl'))
      if (!url?.trim()) return
      document.execCommand(command, false, url.trim())
    } else {
      document.execCommand(command)
    }
    const editor = editorRef.current
    if (editor) {
      onBodyHtmlChange(sanitizeComposeHtml(editor.innerHTML))
      onBodyChange(editor.innerText)
    }
  }

  return (
    <form className="compose-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(attachments) }}>
      <div className="compose-form-heading"><span>{t('from')}</span><span dir="ltr" title={senderAddress}>{senderAddress}</span></div>
      <div className="compose-form-fields">
        <div className="compose-field compose-field-recipient">
          <div className="compose-recipient-line">
            <label htmlFor="compose-recipient">{t('to')}</label>
            <RecipientInput id="compose-recipient" errorId="compose-recipient-error" value={recipient} onChange={onRecipientChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} saveLabel={t('saveRecipient')} savedLabel={t('savedRecipient')} suggestionsLabel={t('savedRecipients')} invalid={hasInvalidRecipient} savedRecipients={savedRecipients} onSaveRecipient={onSaveRecipient} />
            <div className="compose-recipient-options"><button type="button" onClick={() => setIsCcOpen((current) => !current)} aria-expanded={isCcOpen}>{t('cc')}</button><button type="button" onClick={() => setIsBccOpen((current) => !current)} aria-expanded={isBccOpen}>{t('bcc')}</button></div>
          </div>
          {hasInvalidRecipient ? <span id="compose-recipient-error" className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}
        </div>
        {isCcOpen ? <div className="compose-field compose-field-recipient"><div className="compose-recipient-line"><label htmlFor="compose-cc">{t('cc')}</label><RecipientInput id="compose-cc" errorId="compose-cc-error" value={cc} onChange={onCcChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} saveLabel={t('saveRecipient')} savedLabel={t('savedRecipient')} suggestionsLabel={t('savedRecipients')} invalid={hasInvalidCc} savedRecipients={savedRecipients} onSaveRecipient={onSaveRecipient} /></div>{hasInvalidCc ? <span id="compose-cc-error" className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}</div> : null}
        {isBccOpen ? <div className="compose-field compose-field-recipient"><div className="compose-recipient-line"><label htmlFor="compose-bcc">{t('bcc')}</label><RecipientInput id="compose-bcc" errorId="compose-bcc-error" value={bcc} onChange={onBccChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} saveLabel={t('saveRecipient')} savedLabel={t('savedRecipient')} suggestionsLabel={t('savedRecipients')} invalid={hasInvalidBcc} savedRecipients={savedRecipients} onSaveRecipient={onSaveRecipient} /></div>{hasInvalidBcc ? <span id="compose-bcc-error" className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}</div> : null}
        <div className="compose-field">
          <label htmlFor="compose-subject">{t('subject')}</label>
          <Input id="compose-subject" value={subject} onChange={(event) => onSubjectChange(event.target.value)} placeholder={t('subjectPlaceholder')} required aria-required="true" />
        </div>
        <div className="compose-field compose-field-message">
          <label htmlFor="compose-body-editor">{t('message')}</label>
          <div className="compose-editor">
            <div className="compose-editor-toolbar" role="toolbar" aria-label={t('formattingTools')}>
              <button type="button" aria-label={t('bold')} title={t('bold')} onMouseDown={(event) => { event.preventDefault(); applyFormat('bold') }}><IconBold aria-hidden="true" size={16} stroke={1.8} /></button>
              <button type="button" aria-label={t('italic')} title={t('italic')} onMouseDown={(event) => { event.preventDefault(); applyFormat('italic') }}><IconItalic aria-hidden="true" size={16} stroke={1.8} /></button>
              <button type="button" aria-label={t('underline')} title={t('underline')} onMouseDown={(event) => { event.preventDefault(); applyFormat('underline') }}><IconUnderline aria-hidden="true" size={16} stroke={1.8} /></button>
              <button type="button" aria-label={t('bulletList')} title={t('bulletList')} onMouseDown={(event) => { event.preventDefault(); applyFormat('insertUnorderedList') }}><IconList aria-hidden="true" size={16} stroke={1.8} /></button>
              <button type="button" aria-label={t('insertLink')} title={t('insertLink')} onMouseDown={(event) => { event.preventDefault(); applyFormat('createLink') }}><IconLink aria-hidden="true" size={16} stroke={1.8} /></button>
            </div>
            <div ref={editorRef} id="compose-body-editor" className="compose-editor-surface" contentEditable={!isSending} role="textbox" aria-multiline="true" aria-required="true" data-placeholder={t('messagePlaceholder')} onInput={(event) => { onBodyHtmlChange(sanitizeComposeHtml(event.currentTarget.innerHTML)); onBodyChange(event.currentTarget.innerText) }} />
          </div>
          <AttachmentDropzone attachments={attachments} onChange={onAttachmentsChange} disabled={isSending} maxFileSize={attachmentLimits.maxFileSize} maxTotalSize={attachmentLimits.maxTotalSize} />
        </div>
      </div>
      <div className="compose-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={isSending || isDraftSaving}>{t('cancel')}</Button>
        <div className="compose-send-actions">
          <Button variant="ghost" type="button" disabled={isSending || isDraftSaving} onClick={() => onScheduleAtChange(scheduleAt ? '' : new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16))}><IconClock aria-hidden="true" size={15} stroke={1.8} />{scheduleAt ? t('removeSchedule') : t('scheduleSend')}</Button>
          {scheduleAt ? <label className="compose-schedule-field" htmlFor="compose-schedule-at"><span>{t('scheduleSendAt')}</span><Input id="compose-schedule-at" type="datetime-local" value={scheduleAt} disabled={isSending || isDraftSaving} onChange={(event) => onScheduleAtChange(event.target.value)} /></label> : null}
          <Button type="submit" disabled={isSending || isDraftSaving || !canSubmit}><IconPencil aria-hidden="true" size={15} stroke={1.8} />{isSending ? t('sending') : scheduleAt ? t('scheduleSend') : t('send')}</Button>
        </div>
      </div>
    </form>
  )
}
