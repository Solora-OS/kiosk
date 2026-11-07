import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type TileTone = "coral" | "amber" | "teal" | "blue" | "pink" | "green" | "gray" | "red"

export const tileToneClass: Record<TileTone, string> = {
  coral: "bg-member-coral",
  amber: "bg-member-amber",
  teal: "bg-member-teal",
  blue: "bg-member-blue",
  pink: "bg-member-pink",
  green: "bg-member-green",
  gray: "bg-muted-foreground",
  red: "bg-destructive",
}

const sizes = {
  sm: { box: "size-7 rounded-[10px]", icon: "size-[15px]" },
  md: { box: "size-8 rounded-[10px]", icon: "size-[17px]" },
  lg: { box: "size-12 rounded-[10px]", icon: "size-6" },
}

/**
 * A row's icon on a small neutral square. Member colors mean people, so a row's
 * tile stays neutral; only red keeps its color, for rows that delete or end things.
 */
export function IconTile({
  icon: Icon,
  tone,
  size = "md",
  className,
}: {
  icon: LucideIcon
  tone: TileTone
  size?: keyof typeof sizes
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        sizes[size].box,
        tone === "red" ? "bg-destructive text-white" : "bg-secondary text-foreground",
        className,
      )}
    >
      <Icon className={sizes[size].icon} strokeWidth={1.8} />
    </span>
  )
}
