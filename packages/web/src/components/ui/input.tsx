import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 rounded-md border border-hairline bg-surface px-3 py-1 text-sm text-ink',
        'placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
