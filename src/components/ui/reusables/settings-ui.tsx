import { ChevronRight, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { IconTile, type TileTone } from "@/components/ui/reusables/icon-tile"

/**
 * Settings building blocks, the same as the phone's: rounded groups of rows,
 * each row led by a neutral icon tile. Every settings page is built from these
 * so the wall and the phone read alike.
 */

export function SettingsGroup({
  title,
  tone,
  action,
  footer,
  children,
}: {
  title?: string
  tone?: "destructive"
  /** Small control on the right of the heading (a refresh button, say). */
  action?: React.ReactNode
  /** A quiet note under the group. */
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      {title || action ? (
        <div className="flex min-h-9 items-center justify-between gap-2 px-1 pb-2.5">
          {title ? <h2 className={cn("os-label", tone === "destructive" && "!text-destructive")}>{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      <div className="divide-y divide-hairline overflow-hidden rounded-[20px] border border-hairline bg-card">{children}</div>
      {footer ? <p className="px-1.5 pt-2 text-xs leading-relaxed text-muted-foreground">{footer}</p> : null}
    </section>
  )
}

/** Icon tile, label and a line of detail. Shared by every row shape. */
function RowBody({
  icon,
  tone,
  label,
  description,
  destructive,
}: {
  icon?: LucideIcon
  tone: TileTone
  label: React.ReactNode
  description?: React.ReactNode
  destructive?: boolean
}) {
  return (
    <>
      {/* Rows that delete or end things are plain red words, set apart in their own group. */}
      {icon && !destructive ? <IconTile icon={icon} tone={tone} /> : null}
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[0.95rem]", destructive && "text-destructive")}>{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </>
  )
}

/** A tappable row that opens or does something. */
export function ActionRow({
  label,
  description,
  icon,
  tone = "gray",
  onClick,
  destructive = false,
  disabled = false,
  badge,
  trailing,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  icon?: LucideIcon
  tone?: TileTone
  onClick?: () => void
  destructive?: boolean
  disabled?: boolean
  badge?: React.ReactNode
  trailing?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[3.75rem] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors active:bg-secondary disabled:opacity-50"
    >
      <RowBody icon={icon} tone={tone} label={label} description={description} destructive={destructive} />
      {trailing ?? (
        <span className="flex shrink-0 items-center gap-1.5">
          {badge ? <span className="text-sm text-muted-foreground">{badge}</span> : null}
          <ChevronRight className={cn("size-4", destructive ? "text-destructive/60" : "text-muted-foreground")} />
        </span>
      )}
    </button>
  )
}

/**
 * A row holding its own control on the right (a switch, a select, a button).
 * Rendered as a label by default so tapping anywhere flips a switch.
 */
export function SettingRow({
  label,
  description,
  icon,
  tone = "gray",
  as = "label",
  children,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  icon?: LucideIcon
  tone?: TileTone
  as?: "label" | "div"
  children?: React.ReactNode
}) {
  const Tag = as
  return (
    <Tag className="flex min-h-[3.75rem] items-center gap-3 px-4 py-2.5">
      <RowBody icon={icon} tone={tone} label={label} description={description} />
      {children}
    </Tag>
  )
}

/** A green / amber / grey status pill. */
export function StatusPill({ tone, children }: { tone: "good" | "warn" | "bad" | "idle"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2.5 py-0.5 text-[0.72rem] font-semibold",
        tone === "good" && "bg-member-green/15 text-member-green",
        tone === "warn" && "bg-member-amber/15 text-member-amber",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "idle" && "bg-secondary text-muted-foreground",
      )}
    >
      {children}
    </span>
  )
}
