import * as React from "react";
import { cn } from "../../lib/utils.js";

/**
 * This decorative separator needs no Radix behavior because ZeroSheet only
 * uses horizontal rules; `aria-hidden` keeps it out of the accessibility tree.
 */
export function Separator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn("h-px w-full shrink-0 bg-border", className)}
      {...props}
    />
  );
}
