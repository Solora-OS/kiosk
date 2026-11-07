"use client"

import { useEffect, useState } from "react"
import { Check, Eraser, Gift, ListChecks, Luggage, Plus, ShoppingCart, Tent, Wrench, type LucideIcon } from "lucide-react"
import { type Checklist, type MemberColor, memberBg } from "@/lib/data"
import { cn } from "@/lib/utils"
import { celebrateCompletion } from "@/lib/celebration"
import { MoreMenu, editDelete } from "@/components/ui/reusables/more-menu"
import { HeaderAdd } from "@/components/ui/reusables/header-add"
import { IconTile } from "@/components/ui/reusables/icon-tile"
import { BottomSheet, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { useHighlight, useStore } from "@/lib/store"

const colorChoices: MemberColor[] = ["coral", "amber", "teal", "blue", "pink", "green"]

type ListForm = { title: string; color: MemberColor }
type ItemEdit = { listId: string; itemId: string; label: string }
type DeleteTarget =
  | { kind: "list"; listId: string; label: string }
  | { kind: "item"; listId: string; itemId: string; label: string }
  | { kind: "clear"; listId: string; label: string; count: number }

/** A picture for a list from its name, the same guess the phone makes. */
function listIcon(title: string): LucideIcon {
  if (/grocer|shopping|store|market/i.test(title)) return ShoppingCart
  if (/camp|hike|outdoor/i.test(title)) return Tent
  if (/birthday|gift|present|christmas|wish/i.test(title)) return Gift
  if (/fix|repair|house|home|chore/i.test(title)) return Wrench
  if (/pack|trip|travel|vacation|holiday/i.test(title)) return Luggage
  return ListChecks
}

export function ListsView() {
  const { lists, can, currentMember, addList, updateList, deleteList, addItem, updateItem, deleteItem, clearDone, toggleItem } = useStore()
  const canManage = can("lists")
  // Whoever added an item can rename or remove it ("unicorn food"), even without the Lists permission.
  const canChange = (addedBy?: string | null) => canManage || (!!addedBy && addedBy === currentMember?.id)
  const { highlight, register, clearHighlight, refs } = useHighlight("lists")

  const [selected, setSelected] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const [listSheet, setListSheet] = useState<{ editingId: string | null } | null>(null)
  const [listForm, setListForm] = useState<ListForm>({ title: "", color: "blue" })

  const [itemSheet, setItemSheet] = useState<ItemEdit | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  useEffect(() => {
    if (!highlight) return
    setSelected(highlight.id)
    const el = refs.get(highlight.id)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.add("highlight-flash")
    const t = setTimeout(() => {
      el.classList.remove("highlight-flash")
      clearHighlight()
    }, 2000)
    return () => clearTimeout(t)
  }, [highlight, refs, clearHighlight])


  const openAddList = () => {
    setListForm({ title: "", color: "blue" })
    setListSheet({ editingId: null })
  }
  const openEditList = (l: Checklist) => {
    setListForm({ title: l.title, color: l.color })
    setListSheet({ editingId: l.id })
  }
  const saveList = () => {
    if (!listForm.title.trim()) return
    if (listSheet?.editingId) updateList(listSheet.editingId, { title: listForm.title.trim(), color: listForm.color })
    else addList(listForm.title.trim(), listForm.color)
    setListSheet(null)
  }

  const saveItem = () => {
    if (!itemSheet || !itemSheet.label.trim()) return
    updateItem(itemSheet.listId, itemSheet.itemId, itemSheet.label.trim())
    setItemSheet(null)
  }

  const submitDraft = (listId: string) => {
    const label = (drafts[listId] ?? "").trim()
    if (!label) return
    addItem(listId, label)
    setDrafts((p) => ({ ...p, [listId]: "" }))
  }

  // The list in the big pane: the one you tapped, else the groceries, else the first.
  const pinnedId = lists.find((l) => /grocer|shopping/i.test(l.title))?.id ?? lists[0]?.id
  const shownId = selected && lists.some((l) => l.id === selected) ? selected : pinnedId
  const list = lists.find((l) => l.id === shownId)
  const left = (l: Checklist) => l.items.filter((i) => !i.done).length

  return (
    <div className="flex min-h-0 flex-1 gap-5">
      {canManage ? <HeaderAdd label="New list" onClick={openAddList} /> : null}

      {/* The open list, big: tap an item to tick it, type to add one. */}
      {list ? (
        <section ref={register(list.id)} className="os-card flex min-w-0 flex-[1.3] flex-col self-start overflow-hidden">
          <div className="flex items-center gap-3 px-4 pb-3.5 pt-4">
            <IconTile icon={listIcon(list.title)} tone="gray" size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[1.3rem] font-medium">{list.title}</h2>
              <p className="text-xs text-muted-foreground">
                {list.items.length ? (left(list) ? `${left(list)} of ${list.items.length} left` : "All done") : "Empty"}
              </p>
            </div>
            {list.id === pinnedId ? <span className="os-label">Pinned</span> : null}
            {canManage ? (
              <MoreMenu
                label={`${list.title} options`}
                items={[
                  ...editDelete(() => openEditList(list), () => setDeleteTarget({ kind: "list", listId: list.id, label: list.title })),
                  list.items.some((i) => i.done) && {
                    label: "Clear checked items",
                    icon: Eraser,
                    onSelect: () => setDeleteTarget({ kind: "clear", listId: list.id, label: list.title, count: list.items.filter((i) => i.done).length }),
                  },
                ]}
              />
            ) : null}
          </div>

          {/* Anyone can add an item and change their own; managing lists and others' items needs the Lists permission. */}
          <div className="px-4 pb-3">
            <label className="flex min-h-[3.25rem] items-center gap-3 rounded-[14px] border border-hairline bg-background px-4 focus-within:border-foreground">
              <Plus className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={drafts[list.id] ?? ""}
                onChange={(e) => setDrafts((p) => ({ ...p, [list.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && submitDraft(list.id)}
                placeholder="Add an item"
                className="w-full bg-transparent text-[1.05rem] outline-none placeholder:text-muted-foreground"
              />
              {(drafts[list.id] ?? "").trim() ? (
                <button type="button" onClick={() => submitDraft(list.id)} className="shrink-0 rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground">
                  Add
                </button>
              ) : null}
            </label>
          </div>

          {list.items.length === 0 ? (
            <p className="border-t border-hairline px-4 py-4 text-muted-foreground">No items yet.</p>
          ) : (
            <ul className="grid grid-cols-2 border-t border-hairline">
              {[...list.items.filter((i) => !i.done), ...list.items.filter((i) => i.done)].map((item, i) => (
                <li key={item.id} className={cn("flex items-center border-hairline pr-1", i >= 2 && "border-t", i % 2 === 0 && "border-r")}>
                  <button
                    type="button"
                    onClick={() => {
                      toggleItem(list.id, item.id)
                      const willAllBeDone = list.items.filter((x) => x.id !== item.id).every((x) => x.done)
                      if (!item.done && willAllBeDone) celebrateCompletion("strong")
                    }}
                    aria-pressed={item.done}
                    className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left active:bg-secondary"
                  >
                    <span
                      className={cn(
                        "flex size-[1.6rem] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                        item.done ? "border-transparent bg-foreground text-background" : "border-border text-transparent",
                      )}
                    >
                      {item.done ? <Check className="check-pop size-3.5" strokeWidth={3} /> : null}
                    </span>
                    <span className={cn("truncate text-[1rem]", item.done && "text-muted-foreground line-through")}>{item.label}</span>
                  </button>
                  {canChange(item.addedBy) ? (
                    <MoreMenu
                      label={`${item.label} options`}
                      items={editDelete(
                        () => setItemSheet({ listId: list.id, itemId: item.id, label: item.label }),
                        () => setDeleteTarget({ kind: "item", listId: list.id, itemId: item.id, label: item.label }),
                        "Rename",
                      )}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p className="os-card flex-[1.3] self-start px-5 py-8 text-muted-foreground">No lists yet.{canManage ? " Tap + to start one." : ""}</p>
      )}

      {/* Every list as a tile, the phone's grid. The open one is ringed. */}
      <div className="grid flex-1 auto-rows-[9rem] grid-cols-2 content-start gap-4">
        {lists.map((l) => {
          const Icon = listIcon(l.title)
          const n = left(l)
          const on = l.id === shownId
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => setSelected(l.id)}
              aria-pressed={on}
              className={cn(
                "relative flex flex-col items-start rounded-[20px] border bg-card p-4 text-left transition-transform active:scale-[0.98]",
                on ? "border-foreground shadow-[inset_0_0_0_0.5px_var(--foreground)]" : "border-hairline",
              )}
            >
              <span className="flex size-[2.2rem] items-center justify-center rounded-[10px] bg-secondary text-foreground">
                <Icon className="size-[1.1rem]" strokeWidth={1.7} />
              </span>
              <span className={cn("absolute right-4 top-4 size-2.5 rounded-full", memberBg[l.color])} aria-hidden />
              <span className="mt-auto line-clamp-2 text-[1rem] font-medium">{l.title}</span>
              <span className="mt-0.5 text-xs text-muted-foreground">{!l.items.length ? "Empty" : n ? `${n} left` : "All done"}</span>
            </button>
          )
        })}
        {canManage ? (
          <button
            type="button"
            onClick={openAddList}
            className="flex flex-col items-center justify-center gap-1.5 rounded-[20px] border-[1.5px] border-dashed border-border text-sm font-medium text-muted-foreground active:scale-[0.98]"
          >
            <Plus className="size-5" strokeWidth={1.8} />
            New list
          </button>
        ) : null}
      </div>

      {/* List add/edit sheet */}
      <BottomSheet
        open={!!listSheet}
        onClose={() => setListSheet(null)}
        title={listSheet?.editingId ? "Edit list" : "New list"}
        footer={
          <button
            type="button"
            onClick={saveList}
            className="os-button w-full"
          >
            {listSheet?.editingId ? "Save changes" : "Create list"}
          </button>
        }
      >
        <Field label="Name">
          <input
            autoFocus
            value={listForm.title}
            onChange={(e) => setListForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="Groceries"
            className={inputClass}
          />
        </Field>
        <Field label="Color">
          <div className="flex gap-2">
            {colorChoices.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => setListForm((f) => ({ ...f, color: c }))}
                className={cn(
                  "size-8 rounded-full transition-transform",
                  memberBg[c],
                  listForm.color === c ? "ring-2 ring-foreground ring-offset-2 ring-offset-card scale-110" : "",
                )}
              />
            ))}
          </div>
        </Field>
      </BottomSheet>

      {/* Item rename sheet */}
      <BottomSheet
        open={!!itemSheet}
        onClose={() => setItemSheet(null)}
        title="Rename item"
        footer={
          <button
            type="button"
            onClick={saveItem}
            className="os-button w-full"
          >
            Save changes
          </button>
        }
      >
        <Field label="Item">
          <input
            autoFocus
            value={itemSheet?.label ?? ""}
            onChange={(e) => setItemSheet((s) => (s ? { ...s, label: e.target.value } : s))}
            className={inputClass}
          />
        </Field>
      </BottomSheet>

      <ConfirmDialog
        open={!!deleteTarget}
        title={deleteTarget?.kind === "list" ? "Delete list?" : deleteTarget?.kind === "clear" ? "Clear checked items?" : "Delete item?"}
        message={
          deleteTarget?.kind === "clear"
            ? `${deleteTarget.count} ticked ${deleteTarget.count === 1 ? "item comes" : "items come"} off “${deleteTarget.label}”. Unticked items stay.`
            : deleteTarget ? `“${deleteTarget.label}” will be removed.` : ""
        }
        confirmLabel={deleteTarget?.kind === "clear" ? "Clear" : undefined}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget?.kind === "list") deleteList(deleteTarget.listId)
          else if (deleteTarget?.kind === "item") deleteItem(deleteTarget.listId, deleteTarget.itemId)
          else if (deleteTarget?.kind === "clear") clearDone(deleteTarget.listId)
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}
