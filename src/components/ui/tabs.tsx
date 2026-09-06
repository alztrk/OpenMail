import type { ReactNode } from 'react'

type TabsProps = { children: ReactNode }

export function Tabs({ children }: TabsProps) { return <div className="ui-tabs">{children}</div> }
