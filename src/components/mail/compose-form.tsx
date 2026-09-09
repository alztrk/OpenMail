import { IconPencil } from '@tabler/icons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { areValidEmailAddresses } from '@/lib/utils'
import { RecipientChips } from '@/components/mail/recipient-chips'

type ComposeFormProps = {
  recipient: string
  cc: string
  bcc: string
  subject: string
  body: string
  draftStatus: 'idle' | 'saving' | 'saved'
  isSending: boolean
  onRecipientChange: (value: string) => void
  onCcChange: (value: string) => void
  onBccChange: (value: string) => void
  onSubjectChange: (value: string) => void
  onBodyChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void | Promise<void>
}

export function ComposeForm({
  recipient,
  cc,
  bcc,
  subject,
  body,
  draftStatus,
  isSending,
  onRecipientChange,
  onCcChange,
  onBccChange,
  onSubjectChange,
  onBodyChange,
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

  return (
    <form className="compose-form" onSubmit={(event) => { event.preventDefault(); void onSubmit() }}>
      {draftStatus !== 'idle' ? <div className="compose-form-status" role="status">{t(draftStatus === 'saving' ? 'draftSaving' : 'draftSaved')}</div> : null}
      <div className="compose-form-fields">
        <div className="compose-field">
          <div className="compose-field-label-row"><label htmlFor="compose-recipient">{t('to')}</label><div className="compose-recipient-options"><button type="button" onClick={() => setIsCcOpen((current) => !current)} aria-expanded={isCcOpen}>{t('cc')}</button><button type="button" onClick={() => setIsBccOpen((current) => !current)} aria-expanded={isBccOpen}>{t('bcc')}</button></div></div>
          <RecipientChips id="compose-recipient" value={recipient} onChange={onRecipientChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} invalid={hasInvalidRecipient} />
          {hasInvalidRecipient ? <span id="compose-recipient-error" className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}
        </div>
        {isCcOpen ? <div className="compose-field"><label htmlFor="compose-cc">{t('cc')}</label><RecipientChips id="compose-cc" value={cc} onChange={onCcChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} invalid={hasInvalidCc} />{hasInvalidCc ? <span className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}</div> : null}
        {isBccOpen ? <div className="compose-field"><label htmlFor="compose-bcc">{t('bcc')}</label><RecipientChips id="compose-bcc" value={bcc} onChange={onBccChange} placeholder={t('recipientPlaceholder')} removeLabel={t('removeRecipient')} invalid={hasInvalidBcc} />{hasInvalidBcc ? <span className="compose-field-error" role="alert">{t('invalidRecipient')}</span> : null}</div> : null}
        <div className="compose-field">
          <label htmlFor="compose-subject">{t('subject')}</label>
          <Input id="compose-subject" value={subject} onChange={(event) => onSubjectChange(event.target.value)} placeholder={t('subjectPlaceholder')} required aria-required="true" />
        </div>
        <div className="compose-field compose-field-message">
          <label htmlFor="compose-body">{t('message')}</label>
          <Textarea id="compose-body" value={body} onChange={(event) => onBodyChange(event.target.value)} placeholder={t('messagePlaceholder')} rows={9} required aria-required="true" />
        </div>
      </div>
      <div className="compose-actions">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={isSending}>{t('cancel')}</Button>
        <Button type="submit" disabled={isSending || !canSubmit}><IconPencil aria-hidden="true" size={15} stroke={1.8} />{isSending ? t('sending') : t('send')}</Button>
      </div>
    </form>
  )
}
