import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'default' | 'outline' | 'ghost';
  readonly size?: 'default' | 'sm' | 'icon';
}

const variants = {
  default: 'bg-accent text-white hover:opacity-90',
  outline: 'border border-hairline bg-surface hover:border-accent',
  ghost: 'hover:bg-hairline',
} as const;

const sizes = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 px-3 text-xs',
  icon: 'h-6 w-6',
} as const;

export function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md text-sm transition-colors',
        'cursor-pointer disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-accent',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
