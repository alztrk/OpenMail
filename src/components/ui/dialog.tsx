import type { ReactNode } from 'react'

type DialogProps = { open: boolean; title: string; children: ReactNode; onClose: () => void }

export function Dialog({ open, title, children, onClose }: DialogProps) {
  if (!open) return null
  return <div className="ui-dialog-backdrop" role="presentation" onClick={onClose}><section className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(event) => event.stopPropagation()}><div className="ui-dialog-heading"><h2 id="dialog-title">{title}</h2><button type="button" aria-label="Close" onClick={onClose}>×</button></div>{children}</section></div>
}
