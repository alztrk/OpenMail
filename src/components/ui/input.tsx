import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, type = 'text', ...props }, ref) => (
  <input ref={ref} className={cn('ui-input', className)} type={type} {...props} />
))

Input.displayName = 'Input'
