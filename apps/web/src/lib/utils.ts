import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn components are copied into the application and remain ordinary local
 * source. `cn` combines conditional class names, then resolves contradictory
 * Tailwind utilities so a caller can safely override a component default.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
