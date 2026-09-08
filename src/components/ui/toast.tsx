import type { ReactNode } from 'react'

type ToastProps = { open: boolean; children: ReactNode }

export function Toast({ open, children }: ToastProps) { return open ? <div className="ui-toast" role="status" aria-live="polite" aria-atomic="true">{children}</div> : null }
