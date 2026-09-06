import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn('ui-switch', className)} type="checkbox" role="switch" />
}
