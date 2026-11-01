import { cn } from "@/lib/utils"
import { type Member, memberBg } from "@/lib/data"

const sizes = {
  sm: "size-7 text-xs",
  md: "size-9 text-sm",
  lg: "size-12 text-base",
}

export function MemberAvatar({
  member,
  size = "md",
  ring = false,
  className,
}: {
  member: Member
  size?: keyof typeof sizes
  ring?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        memberBg[member.color],
        sizes[size],
        ring && "ring-2 ring-card ring-offset-0",
        className,
      )}
      aria-hidden="true"
    >
      {member.initial}
    </span>
  )
}
