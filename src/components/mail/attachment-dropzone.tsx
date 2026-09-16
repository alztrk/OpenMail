import { IconPaperclip, IconX } from '@tabler/icons-react'
import { useRef, useState, type DragEvent, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatFileSize } from '@/lib/formatters'

export type ComposeAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  dataBase64: string
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

type AttachmentDropzoneProps = {
  attachments: ComposeAttachment[]
  onChange: (attachments: ComposeAttachment[]) => void
  disabled: boolean
  maxFileSize: number
  maxTotalSize: number
}

export function AttachmentDropzone({ attachments, onChange, disabled, maxFileSize, maxTotalSize }: AttachmentDropzoneProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addFiles = async (files: FileList | File[]) => {
    const selectedFiles = Array.from(files)
    if (selectedFiles.length === 0) return
    const currentTotalSize = attachments.reduce((total, attachment) => total + attachment.size, 0)
    const acceptedFiles: File[] = []
    let nextTotalSize = currentTotalSize
    let firstError: string | null = null
    for (const file of selectedFiles) {
      if (file.size >= maxFileSize) {
        firstError ??= t('attachmentTooLarge', { filename: file.name })
        continue
      }
      if (nextTotalSize + file.size > maxTotalSize) {
        firstError ??= t('attachmentsTooLargeTotal')
        continue
      }
      acceptedFiles.push(file)
      nextTotalSize += file.size
    }
    if (acceptedFiles.length === 0) return
    let newAttachments: ComposeAttachment[]
    try {
      newAttachments = await Promise.all(acceptedFiles.map(async (file) => ({
        id: crypto.randomUUID(),
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        dataBase64: encodeBase64(await file.arrayBuffer()),
      })))
    } catch {
      setError(t('attachmentsReadFailed'))
      return
    }
    setError(firstError)
    onChange([...attachments, ...newAttachments])
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files)
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setIsDragging(false)
    if (!disabled && !isReading && event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files)
  }

  return (
    <div className="compose-attachments">
      <label className={`compose-attachment-dropzone${isDragging ? ' is-dragging' : ''}${disabled || isReading ? ' is-disabled' : ''}`} htmlFor="compose-attachments-input" aria-busy={isReading} onDragEnter={(event) => { event.preventDefault(); if (!disabled && !isReading) setIsDragging(true) }} onDragOver={(event) => { event.preventDefault(); if (!disabled && !isReading) setIsDragging(true) }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
        <IconPaperclip aria-hidden="true" size={16} stroke={1.8} />
        <span>{isReading ? t('readingAttachments') : t('dropAttachments')}</span>
        <span className="compose-attachment-browse">{t('chooseFiles')}</span>
        <input ref={inputRef} id="compose-attachments-input" type="file" multiple disabled={disabled || isReading} onChange={handleFileChange} />
      </label>
      {attachments.length > 0 ? <ul className="compose-attachment-list" aria-label={t('attachments')}>
        {attachments.map(({ id, filename, size }) => <li className="compose-attachment-item" key={id}>
          <span className="compose-attachment-icon"><IconPaperclip aria-hidden="true" size={15} stroke={1.8} /></span>
          <span className="compose-attachment-info"><span className="compose-attachment-name" title={filename}>{filename}</span><span className="compose-attachment-size">{formatFileSize(size, i18n.language)}</span></span>
          <button type="button" className="compose-attachment-remove" aria-label={`${t('removeAttachment')}: ${filename}`} title={t('removeAttachment')} disabled={disabled || isReading} onClick={() => onChange(attachments.filter((attachment) => attachment.id !== id))}><IconX aria-hidden="true" size={15} stroke={1.8} /></button>
        </li>)}
      </ul> : null}
      {error ? <p className="compose-attachment-error" role="alert">{error}</p> : null}
    </div>
  )
}
