import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type ButtonVariant = 'default' | 'ghost' | 'danger'
type ButtonSize = 'default' | 'icon'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}

const variantClasses: Record<ButtonVariant, string> = {
  default: 'button-default',
  ghost: 'button-ghost',
  danger: 'button-danger',
}

const sizeClasses: Record<ButtonSize, string> = {
  default: 'button-size-default',
  icon: 'button-size-icon',
}

export function Button({ className, variant = 'default', size = 'default', type = 'button', ...props }: ButtonProps) {
  return <button className={cn('ui-button', variantClasses[variant], sizeClasses[size], className)} type={type} {...props} />
}
