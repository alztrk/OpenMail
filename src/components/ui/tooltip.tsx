import type { ReactNode } from 'react'

type TooltipProps = { label: string; children: ReactNode }

export function Tooltip({ label, children }: TooltipProps) {
  return <span className="ui-tooltip"><span className="ui-tooltip-trigger">{children}</span><span className="ui-tooltip-content" role="tooltip">{label}</span></span>
}
