import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: 'default' | 'outline';
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs whitespace-nowrap',
        variant === 'default' ? 'bg-hairline text-ink' : 'border border-hairline text-ink-2',
        className,
      )}
      {...props}
    />
  );
}
