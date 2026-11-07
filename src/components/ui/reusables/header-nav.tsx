"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Bell, BellOff, Check, Plus, Search, Users, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { MemberAvatar } from "./member-avatar"
import { useHeaderAdd } from "./header-add"
import { setHeaderSlot } from "./header-slot"
import { MoreMenu } from "./more-menu"

// Stable refs: an inline callback would hand the slot back and forth on every
// render and remount whatever a page put in it.
const titleSlot = (el: HTMLElement | null) => setHeaderSlot("title", el)
const extrasSlot = (el: HTMLElement | null) => setHeaderSlot("extras", el)

/**
 * The page header, the same as the phone's: a live mono caption over a serif
 * title, and every action in one pill on the right (add, search, bell, and on
 * pages that filter by person, the family's faces). Pages can put a richer
 * title (a clock, a month with arrows) or extra controls in through HeaderSlot.
 */
export function HeaderNav({
  title,
  caption,
  customTitle = false,
  showPeople = false,
}: {
  title: string
  caption?: string
  /** The page draws its own title through <HeaderSlot name="title">. */
  customTitle?: boolean
  showPeople?: boolean
}) {
  const { unreadCount } = useStore()
  const add = useHeaderAdd()
  const [searchOpen, setSearchOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)

  return (
    <header data-effects-avoid="top" className="relative z-30 flex shrink-0 items-end justify-between gap-6 border-b border-hairline px-8 pb-4 pt-6">
      <div className="min-w-0">
        {caption ? <p className="os-label truncate">{caption}</p> : null}
        <div className="mt-2 flex min-w-0 items-end gap-3">
          {customTitle ? null : <h1 className="truncate font-display text-[2.85rem] leading-none">{title}</h1>}
          <div ref={titleSlot} className="contents" />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5">
        <div ref={extrasSlot} className="contents" />
        <div className="flex items-center gap-0.5 rounded-full border border-hairline bg-card p-1">
          {add ? (
            <button
              type="button"
              onClick={add.onClick}
              aria-label={add.label}
              className="pop-in flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground"
            >
              <Plus className="size-[1.15rem]" strokeWidth={2} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            className="flex size-11 items-center justify-center rounded-full text-muted-foreground"
          >
            <Search className="size-[1.15rem]" strokeWidth={1.6} />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setNotifOpen((v) => !v)}
              aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
              className={cn(
                "relative flex size-11 items-center justify-center rounded-full transition-colors",
                notifOpen ? "bg-secondary text-foreground" : "text-muted-foreground",
              )}
            >
              <Bell className="size-[1.15rem]" strokeWidth={1.6} />
              {unreadCount > 0 ? (
                <span className="absolute right-[0.7rem] top-[0.7rem] size-[7px] rounded-full border-[1.5px] border-card bg-foreground" />
              ) : null}
            </button>
            {notifOpen ? <NotificationsPopover onClose={() => setNotifOpen(false)} /> : null}
          </div>
          {showPeople ? (
            <div className="relative flex items-center">
              <span className="mx-1 h-6 w-px bg-hairline" aria-hidden />
              <PeopleButton open={peopleOpen} onToggle={() => setPeopleOpen((v) => !v)} onClose={() => setPeopleOpen(false)} />
            </div>
          ) : null}
        </div>
      </div>

      {searchOpen ? <SearchScreen onClose={() => setSearchOpen(false)} /> : null}
    </header>
  )
}

/** The family's faces as the people filter. One face ringed when filtered to them. */
function PeopleButton({ open, onToggle, onClose }: { open: boolean; onToggle: () => void; onClose: () => void }) {
  const { members, activeMember, setActiveMember, getMember } = useStore()
  const people = members.filter((m) => m.id !== "family")
  const picked = activeMember ? getMember(activeMember) : null
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, open, onClose)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-label={picked ? `Showing ${picked.name}. Change` : "Showing everyone. Filter by person"}
        aria-expanded={open}
        className={cn("flex h-11 items-center rounded-full px-2 transition-colors", open && "bg-secondary")}
      >
        {picked ? (
          <MemberAvatar member={picked} size="sm" className="ring-2 ring-foreground ring-offset-2 ring-offset-card" />
        ) : people.length ? (
          <span className="flex -space-x-1.5">
            {people.slice(0, 4).map((m) => <MemberAvatar key={m.id} member={m} size="sm" ring />)}
          </span>
        ) : (
          <Users className="mx-1 size-[1.15rem] text-muted-foreground" />
        )}
      </button>
      {open ? (
        <div className="pop-in absolute right-0 top-[3.4rem] z-40 w-72 origin-top-right overflow-hidden rounded-[20px] border border-hairline bg-popover p-1.5 shadow-[0_16px_40px_-16px_rgb(0_0_0/0.35)]">
          <p className="os-label px-3 pb-1 pt-2.5">Show</p>
          {[null, ...people].map((m) => {
            const on = (m?.id ?? null) === activeMember
            return (
              <button
                key={m?.id ?? "everyone"}
                type="button"
                onClick={() => {
                  setActiveMember(m?.id ?? null)
                  onClose()
                }}
                className={cn("flex h-12 w-full items-center gap-3 rounded-xl px-2.5 text-left", on && "bg-secondary")}
              >
                {m ? (
                  <MemberAvatar member={m} size="sm" />
                ) : (
                  <span className="flex size-7 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                    <Users className="size-3.5" />
                  </span>
                )}
                <span className="flex-1 text-[0.95rem]">{m ? m.name : "Everyone"}</span>
                {on ? <Check className="size-4" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function useOutside(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("pointerdown", away)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("pointerdown", away)
      document.removeEventListener("keydown", esc)
    }
  }, [ref, open, onClose])
}

function NotificationsList({ max }: { max?: string }) {
  const { notifications, toggleNotificationRead, deleteNotification, getMember } = useStore()
  if (notifications.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <BellOff className="size-5" />
        </span>
        <p className="text-sm font-medium text-muted-foreground">No notifications</p>
      </div>
    )
  }
  return (
    <ul className={cn("divide-y divide-hairline overflow-y-auto overscroll-contain", max)}>
      {notifications.map((n) => (
        <li key={n.id} className={cn("flex items-start gap-3 py-3 pl-4 pr-2", !n.read && "bg-secondary")}>
          <MemberAvatar member={getMember(n.memberId)} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                {!n.read ? <span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-hidden /> : null}
                <span className="truncate">{n.title}</span>
              </p>
              <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">{n.time}</span>
            </div>
            <p className="text-xs text-muted-foreground">{n.body}</p>
          </div>
          <MoreMenu
            label={`${n.title} options`}
            items={[
              { label: n.read ? "Mark unread" : "Mark read", icon: n.read ? BellOff : Check, onSelect: () => toggleNotificationRead(n.id) },
              { label: "Delete", icon: X, destructive: true, onSelect: () => deleteNotification(n.id) },
            ]}
          />
        </li>
      ))}
    </ul>
  )
}

function NotificationsPopover({ onClose }: { onClose: () => void }) {
  const { unreadCount, markAllNotificationsRead } = useStore()
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, true, onClose)
  return (
    <div
      ref={ref}
      className="pop-in absolute right-0 top-[3.4rem] z-40 w-[26rem] max-w-[calc(100vw-2rem)] origin-top-right overflow-hidden rounded-[20px] border border-hairline bg-popover shadow-[0_16px_40px_-16px_rgb(0_0_0/0.35)]"
    >
      <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
        <p className="os-label !text-foreground">Notifications</p>
        {unreadCount > 0 ? (
          <button type="button" onClick={markAllNotificationsRead} className="text-xs font-medium text-muted-foreground underline underline-offset-4">
            Mark all read
          </button>
        ) : (
          <span className="text-[0.75rem] font-medium text-muted-foreground">All caught up</span>
        )}
      </div>
      <NotificationsList max="max-h-[26rem]" />
    </div>
  )
}

/**
 * Search takes the whole screen, like the phone: the field across the top,
 * matches on the left, what's new on the right. The touch keyboard rises under it.
 */
function SearchScreen({ onClose }: { onClose: () => void }) {
  const { search, navigateToResult, getMember, unreadCount, markAllNotificationsRead } = useStore()
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const results = search(query)
  useEffect(() => inputRef.current?.focus(), [])

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background animate-in fade-in duration-200">
      <div className="flex items-center gap-3 px-8 pb-4 pt-6">
        <label className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-[16px] border border-foreground bg-card px-4">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="Search events, chores, lists, meals…"
            className="w-full min-w-0 bg-transparent text-xl outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <button type="button" aria-label="Clear" onClick={() => setQuery("")} className="hit shrink-0 text-muted-foreground">
              <X className="size-4" />
            </button>
          ) : null}
        </label>
        <button type="button" onClick={onClose} className="os-button-quiet !text-foreground">
          Cancel
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-5 px-8 pb-6">
        <section className="flex min-w-0 flex-[1.3] flex-col gap-2">
          <p className="os-label px-1">{query.trim() ? `${results.length} ${results.length === 1 ? "match" : "matches"}` : "Find anything"}</p>
          {!query.trim() ? (
            <p className="px-1 pt-2 text-muted-foreground">Events, chores, lists and meals in the family hub.</p>
          ) : results.length > 0 ? (
            <ul className="min-h-0 divide-y divide-hairline overflow-y-auto rounded-[20px] border border-hairline bg-card">
              {results.map((r) => (
                <li key={r.key}>
                  <button
                    type="button"
                    onClick={() => {
                      navigateToResult(r)
                      onClose()
                    }}
                    className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-secondary"
                  >
                    <MemberAvatar member={getMember(r.memberId)} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[1rem]">{r.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{r.detail}</p>
                    </div>
                    <span className="os-label shrink-0">{r.category}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1 pt-2 text-muted-foreground">No matches for &ldquo;{query}&rdquo;</p>
          )}
        </section>
        <section className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <p className="os-label !text-foreground">Notifications</p>
            {unreadCount > 0 ? (
              <button type="button" onClick={markAllNotificationsRead} className="os-label underline underline-offset-4">
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="min-h-0 overflow-hidden rounded-[20px] border border-hairline bg-card">
            <NotificationsList max="max-h-full" />
          </div>
        </section>
      </div>
    </div>,
    document.body,
  )
}
