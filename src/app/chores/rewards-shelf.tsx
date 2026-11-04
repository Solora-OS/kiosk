"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Flame, Gift, Plus, Star, X } from "lucide-react"
import { TabLoading } from "@/components/os/loading"
import { api } from "@/lib/api"
import type { Member, Reward, RewardsSummary } from "@/lib/data"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { ActionRow } from "@/components/ui/reusables/action-row"
import { BottomSheet, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"

/**
 * Points, streaks and the rewards shelf under the chore list. Kept identical
 * in mobile/ and kiosk/. Who sees what:
 *  - a kid: their own points, and "Get it" for themselves (a parent approves)
 *  - a parent on their phone: everyone's points, "Give" to anyone (already
 *    approved), the shelf to edit, and requests to approve or decline
 *  - the wall: everyone's points and "Give" to anyone, as a request
 */
/** Survives the shelf unmounting (switching tabs), unlike component state. */
let lastSummary: RewardsSummary | null = null

export function RewardsShelf() {
  const { chores, members, getMember, currentMember, can } = useStore()
  const managesChores = can("chores")
  // A parent's own device; the wall manages chores too but has no member and can't approve.
  const isParent = managesChores && !!currentMember
  // Start from the last summary this screen saw, so reopening it is instant.
  const [summary, setSummaryState] = useState<RewardsSummary | null>(lastSummary)
  const setSummary = useCallback((next: RewardsSummary) => {
    lastSummary = next
    setSummaryState(next)
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [givingReward, setGivingReward] = useState<Reward | null>(null)
  const [editing, setEditing] = useState<Reward | "new" | null>(null)
  const [deleting, setDeleting] = useState<Reward | null>(null)

  const load = useCallback(() => {
    api.getRewards().then(setSummary).catch(() => { /* keep what we have; the hub may be away */ })
  }, [setSummary])

  // Load straight away on open; after that, balances move whenever a chore is
  // ticked anywhere (debounced, since a tick can arrive as a burst of updates).
  const opened = useRef(false)
  useEffect(() => {
    if (!opened.current) {
      opened.current = true
      load()
      return
    }
    const t = setTimeout(load, 400)
    return () => clearTimeout(t)
  }, [chores, load])
  useEffect(() => {
    const id = setInterval(load, 30_000)
    window.addEventListener("focus", load)
    return () => { clearInterval(id); window.removeEventListener("focus", load) }
  }, [load])

  if (!summary) {
    return (
      <TabLoading tab="rewards" wall className="py-4" />
    )
  }

  const pointsFor = (id: string) => summary.points.find((p) => p.memberId === id)
  const shown: Member[] = managesChores ? members.filter((m) => m.id !== "family") : currentMember ? [currentMember] : []
  const myBalance = currentMember ? pointsFor(currentMember.id)?.balance ?? 0 : 0
  const requested = summary.redemptions.filter((r) => r.status === "requested")
  const mine = requested.filter((r) => r.memberId === currentMember?.id)

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : "That didn't work. Try again.") }
    load()
  }

  return (
    <section className="space-y-4 pt-2">
      {/* Points and streaks */}
      {shown.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {shown.map((m) => {
            const p = pointsFor(m.id)
            return (
              <div key={m.id} className="flex items-center gap-2.5 rounded-lg bg-card px-3 py-2">
                <MemberAvatar member={m} size="sm" />
                <div className="leading-tight">
                  <p className="flex items-center gap-1 text-sm font-semibold tabular">
                    <Star className="size-3.5 fill-member-amber text-member-amber" />
                    {p?.balance ?? 0}
                    <span className="font-normal text-muted-foreground">points</span>
                  </p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    {p && p.streak > 0 ? (
                      <><Flame className="size-3 text-season" /> {p.streak}-day streak</>
                    ) : (
                      "No streak yet"
                    )}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {/* Requests waiting for a parent */}
      {isParent && requested.length > 0 ? (
        <div className="space-y-2">
          <p className="os-label px-1">Waiting for you</p>
          {requested.map((r) => (
            <div key={r.id} className="flex items-center gap-3 rounded-lg bg-card p-3">
              <MemberAvatar member={getMember(r.memberId)} size="sm" />
              <p className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">{getMember(r.memberId).name}</span> wants{" "}
                <span className="font-semibold">{r.title}</span>
                <span className="text-muted-foreground"> · {r.cost} points</span>
              </p>
              <button type="button" aria-label="Decline" onClick={() => void act(() => api.decideRedemption(r.id, "decline"))}
                className="flex size-9 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <X className="size-4" />
              </button>
              <button type="button" aria-label="Approve" onClick={() => void act(() => api.decideRedemption(r.id, "approve"))}
                className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="size-4" strokeWidth={3} />
              </button>
            </div>
          ))}
        </div>
      ) : !isParent && (mine.length > 0 || (!currentMember && requested.length > 0)) ? (
        <p className="rounded-lg bg-card px-3 py-2.5 text-sm text-muted-foreground">
          Waiting for a parent: {(currentMember ? mine : requested).map((r) => `${getMember(r.memberId).name}: ${r.title}`).join(", ")}
        </p>
      ) : null}

      {/* The shelf */}
      <div className="space-y-2">
        <p className="os-label px-1">Rewards</p>
        {summary.rewards.map((reward) => {
          const short = reward.cost - myBalance
          return (
            <ActionRow
              key={reward.id}
              onEdit={isParent ? () => setEditing(reward) : undefined}
              onDelete={isParent ? () => setDeleting(reward) : undefined}
            >
              <div className="flex items-center gap-3 bg-card p-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-season/10 text-season">
                  <Gift className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-tight">{reward.title}</p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground tabular">
                    <Star className="size-3 fill-member-amber text-member-amber" /> {reward.cost} points
                  </p>
                </div>
                {managesChores ? (
                  <button type="button" onClick={() => setGivingReward(reward)}
                    className="shrink-0 rounded-full bg-secondary px-3.5 py-1.5 text-sm font-semibold">
                    Give
                  </button>
                ) : currentMember ? (
                  <button type="button" disabled={short > 0}
                    onClick={() => void act(() => api.redeemReward(reward.id))}
                    className={cn("shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold",
                      short > 0 ? "bg-secondary text-muted-foreground" : "bg-primary text-primary-foreground")}>
                    {short > 0 ? `${short} to go` : "Get it"}
                  </button>
                ) : null}
              </div>
            </ActionRow>
          )
        })}
        {summary.rewards.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            {isParent ? "Add something points can buy, like picking the movie or 30 minutes of screen time." : "No rewards yet. Ask a parent to add some."}
          </p>
        ) : null}
        {isParent ? (
          <button type="button" onClick={() => setEditing("new")}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary">
            <Plus className="size-4" /> Add reward
          </button>
        ) : null}
        {error ? <p className="px-1 text-sm text-destructive">{error}</p> : null}
      </div>

      {/* Who gets it (parents and the wall) */}
      <BottomSheet open={!!givingReward} onClose={() => setGivingReward(null)} title={givingReward ? `Give "${givingReward.title}"` : ""}>
        <div className="space-y-2">
          {!isParent ? <p className="text-sm text-muted-foreground">A parent approves it on their phone.</p> : null}
          {members.filter((m) => m.id !== "family").map((m) => {
            const balance = pointsFor(m.id)?.balance ?? 0
            const enough = givingReward ? balance >= givingReward.cost : false
            return (
              <button key={m.id} type="button" disabled={!enough}
                onClick={() => {
                  const r = givingReward!
                  setGivingReward(null)
                  void act(() => api.redeemReward(r.id, m.id))
                }}
                className={cn("flex w-full items-center gap-3 rounded-lg bg-card p-3 text-left", !enough && "opacity-50")}>
                <MemberAvatar member={m} size="sm" />
                <span className="flex-1 font-medium">{m.name}</span>
                <span className="text-sm text-muted-foreground tabular">
                  {enough ? `${balance} points` : `${(givingReward?.cost ?? 0) - balance} to go`}
                </span>
              </button>
            )
          })}
        </div>
      </BottomSheet>

      <RewardSheet
        reward={editing}
        onClose={() => setEditing(null)}
        onSave={(input) => {
          const target = editing
          setEditing(null)
          void act(() => (target && target !== "new" ? api.updateReward(target.id, input) : api.createReward(input)))
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        title="Remove reward?"
        message={deleting ? `"${deleting.title}" comes off the shelf. Points already spent stay spent.` : ""}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting
          setDeleting(null)
          if (target) void act(() => api.deleteReward(target.id))
        }}
      />
    </section>
  )
}

function RewardSheet({
  reward,
  onClose,
  onSave,
}: {
  reward: Reward | "new" | null
  onClose: () => void
  onSave: (input: { title: string; cost: number }) => void
}) {
  const [title, setTitle] = useState("")
  const [cost, setCost] = useState("50")

  useEffect(() => {
    if (!reward) return
    setTitle(reward === "new" ? "" : reward.title)
    setCost(reward === "new" ? "50" : String(reward.cost))
  }, [reward])

  const costNumber = Number(cost)
  const valid = title.trim() !== "" && Number.isInteger(costNumber) && costNumber > 0

  return (
    <BottomSheet
      open={!!reward}
      onClose={onClose}
      title={reward === "new" ? "Add reward" : "Edit reward"}
      footer={
        <button type="button" disabled={!valid} onClick={() => onSave({ title: title.trim(), cost: costNumber })}
          className="w-full rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {reward === "new" ? "Add reward" : "Save changes"}
        </button>
      }
    >
      <Field label="Reward">
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pick the movie" className={inputClass} />
      </Field>
      <Field label="Points">
        <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" className={inputClass} />
      </Field>
    </BottomSheet>
  )
}
