import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Slider({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn('ui-slider', className)} type="range" />
}
