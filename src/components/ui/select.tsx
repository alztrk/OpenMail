import * as SelectPrimitive from '@radix-ui/react-select'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'

export const Select = SelectPrimitive.Root

export function SelectTrigger({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger className={cn('ui-select-trigger', className)} {...props}>{children}<SelectPrimitive.Icon><IconChevronDown aria-hidden="true" size={15} stroke={1.8} /></SelectPrimitive.Icon></SelectPrimitive.Trigger>
}

export const SelectValue = SelectPrimitive.Value

export function SelectContent({ className, children, position = 'popper', ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal><SelectPrimitive.Content className={cn('ui-select-content', className)} position={position} {...props}><SelectPrimitive.Viewport className="ui-select-viewport">{children}</SelectPrimitive.Viewport></SelectPrimitive.Content></SelectPrimitive.Portal>
}

export function SelectItem({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item className={cn('ui-select-item', className)} {...props}><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><IconCheck aria-hidden="true" size={14} stroke={2} /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>
}
