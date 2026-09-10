import { IconBold, IconItalic, IconLink, IconList, IconPencil, IconUnderline } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify from 'dompurify'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { areValidEmailAddresses } from '@/lib/utils'
import { RecipientInput, type SavedRecipient } from '@/components/mail/recipient-input'
import { AttachmentDropzone, type ComposeAttachment } from '@/components/mail/attachment-dropzone'

type ComposeFormProps = {
  recipient: string
  cc: string
  bcc: string
  subject: string
  body: string
  bodyHtml: string
  attachments: ComposeAttachment[]
  attachmentLimits: { maxFileSize: number; maxTotalSize: number }
  isSending: boolean
  onRecipientChange: (value: string) => void
  onCcChange: (value: string) => void
  onBccChange: (value: string) => void
  onSubjectChange: (value: string) => void
  onBodyChange: (value: string) => void
  onBodyHtmlChange: (value: string) => void
  onAttachmentsChange: (attachments: ComposeAttachment[]) => void
  savedRecipients: SavedRecipient[]
  onSaveRecipient: (email: string) => void
  onCancel: () => void
  onSubmit: (attachments: ComposeAttachment[]) => void | Promise<void>
}

export function ComposeForm({
  recipient,
  cc,
  bcc,
  subject,
  body,
  bodyHtml,
  attachments,
  attachmentLimits,
  isSending,
  onRecipientChange,
  onCcChange,
  onBccChange,
  onSubjectChange,
  onBodyChange,
  onBodyHtmlChange,
  onAttachmentsChange,
  savedRecipients,
  onSaveRecipient,
  onCancel,
  onSubmit,
}: ComposeFormProps) {
  const { t } = useTranslation()
  const hasInvalidRecipient = /[;,]/.test(recipient) && !areValidEmailAddresses(recipient)
  const hasInvalidCc = /[;,]/.test(cc) && !areValidEmailAddresses(cc)
  const hasInvalidBcc = /[;,]/.test(bcc) && !areValidEmailAddresses(bcc)
  const canSubmit = areValidEmailAddresses(recipient) && !hasInvalidCc && !hasInvalidBcc && subject.trim().length > 0 && body.trim().length > 0
  const [isCcOpen, setIsCcOpen] = useState(false)
  const [isBccOpen, setIsBccOpen] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editorRef.current || editorRef.current.innerHTML === bodyHtml) return
    editorRef.current.innerHTML = DOMPurify.sanitize(bodyHtml)
  }, [bodyHtml])

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
      onBodyHtmlChange(DOMPurify.sanitize(editor.innerHTML))
      onBodyChange(editor.innerText)
    }
  }

  return (
    <form className="compose-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(attachments) }}>
      <div className="compose-form-fields">
        <div className="compose-field compose-field-recipient">
          <div className="compose-recipient-line">
            <label htmlFor="compose-recipient">{t('to')}</label>
            <RecipientInput id="compose-recipient" value={recipient} onChange={onRecipientChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} saveLabel={t('saveRecipient')} savedLabel={t('savedRecipient')} suggestionsLabel={t('savedRecipients')} invalid={hasInvalidRecipient} savedRecipients={savedRecipients} onSaveRecipient={onSaveRecipient} />
            <div className="compose-recipient-options"><button type="button" onClick={() => setIsCcOpen((current) => !current)} aria-expanded={isCcOpen}>{t('cc')}</button><button type="button" onClick={() => setIsBccOpen((current) => !current)} aria-expanded={isBccOpen}>{t('bcc')}</button></div>
          </div>
          {hasInvalidRecipient ? <span id="compose-recipient-error" className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}
        </div>
        {isCcOpen ? <div className="compose-field compose-field-recipient"><div className="compose-recipient-line"><label htmlFor="compose-cc">{t('cc')}</label><RecipientInput id="compose-cc" value={cc} onChange={onCcChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} saveLabel={t('saveRecipient')} savedLabel={t('savedRecipient')} suggestionsLabel={t('savedRecipients')} invalid={hasInvalidCc} savedRecipients={savedRecipients} onSaveRecipient={onSaveRecipient} /></div>{hasInvalidCc ? <span className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}</div> : null}
        {isBccOpen ? <div className="compose-field compose-field-recipient"><div className="compose-recipient-line"><label htmlFor="compose-bcc">{t('bcc')}</label><RecipientInput id="compose-bcc" value={bcc} onChange={onBccChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} saveLabel={t('saveRecipient')} savedLabel={t('savedRecipient')} suggestionsLabel={t('savedRecipients')} invalid={hasInvalidBcc} savedRecipients={savedRecipients} onSaveRecipient={onSaveRecipient} /></div>{hasInvalidBcc ? <span className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}</div> : null}
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
            <div ref={editorRef} id="compose-body-editor" className="compose-editor-surface" contentEditable={!isSending} role="textbox" aria-multiline="true" aria-required="true" data-placeholder={t('messagePlaceholder')} onInput={(event) => { onBodyHtmlChange(DOMPurify.sanitize(event.currentTarget.innerHTML)); onBodyChange(event.currentTarget.innerText) }} />
          </div>
          <AttachmentDropzone attachments={attachments} onChange={onAttachmentsChange} disabled={isSending} maxFileSize={attachmentLimits.maxFileSize} maxTotalSize={attachmentLimits.maxTotalSize} />
        </div>
      </div>
      <div className="compose-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={isSending}>{t('cancel')}</Button>
        <Button type="submit" disabled={isSending || !canSubmit}><IconPencil aria-hidden="true" size={15} stroke={1.8} />{isSending ? t('sending') : t('send')}</Button>
      </div>
    </form>
  )
}
