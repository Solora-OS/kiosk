"use client"

import { useEffect, useRef, useState } from "react"
import { Bell, BellOff, Check, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { MemberAvatar } from "./member-avatar"
import { ActionRow } from "./action-row"

export function HeaderNav({ title, subtitle }: { title: string; subtitle?: string }) {
  const {
    search,
    navigateToResult,
    notifications,
    unreadCount,
    toggleNotificationRead,
    deleteNotification,
    markAllNotificationsRead,
    getMember,
  } = useStore()

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [notifOpen, setNotifOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const unread = unreadCount
  const results = search(query)

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus()
  }, [searchOpen])

  const closeSearch = () => {
    setQuery("")
    setSearchOpen(false)
  }

  return (
    <header className="relative z-30">
      <div className="w-full px-8 pb-4 pt-7">
        {/* Eyebrow subtitle over a display-serif title; quiet actions on the right */}
        <div className="flex items-end justify-between gap-6">
          <div className="min-w-0">
            {subtitle ? <p className="os-label mb-3 truncate">{subtitle}</p> : null}
            <h1 className="truncate font-display text-[2.75rem] leading-none">{title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              aria-label="Search"
              className={cn(
                "flex h-11 items-center gap-3 rounded-md border px-4 text-sm transition-colors",
                searchOpen ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <Search className="size-4" />
              <span className="hidden w-28 text-left md:inline">Search</span>
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setNotifOpen((v) => !v)}
                aria-label="Notifications"
                className={cn(
                  "relative flex size-11 items-center justify-center rounded-md border transition-colors",
                  notifOpen ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <Bell className="size-[1.15rem]" strokeWidth={1.6} />
                {unread > 0 ? (
                  <span className="absolute right-2.5 top-2.5 size-1.5 rounded-full bg-season" />
                ) : null}
              </button>

              {notifOpen ? (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setNotifOpen(false)} aria-hidden />
                  <div className="absolute right-0 top-13 z-40 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-popover shadow-[0_12px_40px_-12px_rgb(0_0_0/0.25)]">
                    <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
                      <p className="os-label !text-foreground">Notifications</p>
                      {unread > 0 ? (
                        <button
                          type="button"
                          onClick={markAllNotificationsRead}
                          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        >
                          Mark all read
                        </button>
                      ) : (
                        <span className="text-[0.75rem] font-medium text-muted-foreground">All caught up</span>
                      )}
                    </div>
                    {notifications.length > 0 ? (
                      <ul className="max-h-80 divide-y divide-hairline overflow-y-auto overscroll-contain">
                        {notifications.map((n) => {
                          const member = getMember(n.memberId)
                          return (
                            <li key={n.id}>
                              <ActionRow
                                rounded=""
                                editLabel={n.read ? "Unread" : "Read"}
                                editIcon={n.read ? BellOff : Check}
                                onEdit={() => toggleNotificationRead(n.id)}
                                onDelete={() => deleteNotification(n.id)}
                              >
                                <div className={cn("flex gap-3 bg-card px-4 py-3", !n.read && "bg-secondary")}>
                                  <MemberAvatar member={member} size="sm" />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                                        {!n.read ? (
                                          <span className="size-1.5 shrink-0 rounded-full bg-season" aria-hidden />
                                        ) : null}
                                        <span className="truncate">{n.title}</span>
                                      </p>
                                      <span className="shrink-0 text-[0.75rem] text-muted-foreground">{n.time}</span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{n.body}</p>
                                  </div>
                                </div>
                              </ActionRow>
                            </li>
                          )
                        })}
                      </ul>
                    ) : (
                      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                        <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                          <BellOff className="size-5" />
                        </span>
                        <p className="text-sm font-medium text-muted-foreground">No notifications</p>
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* Search panel */}
        {searchOpen ? (
          <div className="mt-5">
            <div className="flex items-center gap-3 border-b border-foreground pb-3">
              <Search className="size-5 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search events, chores, lists, meals…"
                className="w-full bg-transparent text-xl outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                aria-label="Close search"
                onClick={closeSearch}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {query.trim() ? (
              <div className="mt-2 max-h-80 overflow-y-auto overscroll-contain">
                {results.length > 0 ? (
                  <ul className="divide-y divide-hairline">
                    {results.map((r) => {
                      const member = getMember(r.memberId)
                      return (
                        <li key={r.key}>
                          <button
                            type="button"
                            onClick={() => {
                              navigateToResult(r)
                              closeSearch()
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary"
                          >
                            <MemberAvatar member={member} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{r.title}</p>
                              <p className="truncate text-xs text-muted-foreground">{r.detail}</p>
                            </div>
                            <span className="os-label shrink-0">{r.category}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No matches for &ldquo;{query}&rdquo;
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  )
}
