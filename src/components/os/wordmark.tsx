import { cn } from "@/lib/utils"

/**
 * The Solora wordmark: set in the display serif, closed with a full stop in
 * the season accent. That dot is the brand — no app-icon tile anywhere.
 * `plain` greys the dot, for boot screens, which carry no colour.
 */
export function Wordmark({ className, plain = false }: { className?: string; plain?: boolean }) {
  return (
    <span className={cn("font-display leading-none text-foreground", className)}>
      Solora<span className={plain ? "text-muted-foreground" : "text-season"}>.</span>
    </span>
  )
}

/** The line under the wordmark on boot screens. */
export const MOTTO = "The heart of the home."
