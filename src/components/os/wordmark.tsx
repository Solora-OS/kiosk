import { cn } from "@/lib/utils"

/**
 * The Lumora wordmark: set in the display serif, closed with a full stop in
 * the season accent. That dot is the brand — no app-icon tile anywhere.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display leading-none text-foreground", className)}>
      Solora<span className="text-season">.</span>
    </span>
  )
}
