import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// The shadcn class-merge helper (design system spec section 1). Later Tailwind
// classes win over earlier ones, which is what lets a component accept a
// className override without fighting its own base classes.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
