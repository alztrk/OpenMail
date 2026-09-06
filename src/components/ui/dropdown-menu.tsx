import type { ReactNode } from 'react'

type DropdownMenuProps = { trigger: ReactNode; children: ReactNode }

export function DropdownMenu({ trigger, children }: DropdownMenuProps) { return <details className="ui-dropdown"><summary>{trigger}</summary><div className="ui-dropdown-content">{children}</div></details> }
