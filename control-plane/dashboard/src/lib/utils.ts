import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names with Tailwind-aware conflict resolution.
 * @param {...ClassValue} inputs Class values to merge.
 * @returns {string} The merged class name string.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
