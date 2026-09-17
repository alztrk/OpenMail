import type { ReactNode } from 'react'

type ToastProps = { open: boolean; children: ReactNode; action?: ReactNode }

export function Toast({ open, children, action }: ToastProps) { return open ? <div className="ui-toast" role="status" aria-live="polite" aria-atomic="true"><span>{children}</span>{action}</div> : null }
