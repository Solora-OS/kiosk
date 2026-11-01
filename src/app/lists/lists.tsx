"use client"

import { useEffect, useState } from "react"
import { Check, ChevronDown, Eraser, Plus } from "lucide-react"
import { type Checklist, type MemberColor, memberBg, memberSoft } from "@/lib/data"
import { cn } from "@/lib/utils"
import { celebrateCompletion } from "@/lib/celebration"
import { ActionRow } from "@/components/ui/reusables/action-row"
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

export function ListsView() {
  const { lists, can, currentMember, addList, updateList, deleteList, addItem, updateItem, deleteItem, clearDone, toggleItem } = useStore()
  const canManage = can("lists")
  // Whoever added an item can rename or remove it ("unicorn food"), even without the Lists permission.
  const canChange = (addedBy?: string | null) => canManage || (!!addedBy && addedBy === currentMember?.id)
  const { highlight, register, clearHighlight, refs } = useHighlight("lists")

  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const [listSheet, setListSheet] = useState<{ editingId: string | null } | null>(null)
  const [listForm, setListForm] = useState<ListForm>({ title: "", color: "blue" })

  const [itemSheet, setItemSheet] = useState<ItemEdit | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  useEffect(() => {
    if (!highlight) return
    setOpen((p) => ({ ...p, [highlight.id]: true }))
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

  const toggleOpen = (listId: string, isOpen: boolean) => setOpen((prev) => ({ ...prev, [listId]: !isOpen }))

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

  return (
    <div className="space-y-4 px-4 py-4">
      {lists.map((list) => {
        const done = list.items.filter((i) => i.done).length
        const allDone = done === list.items.length && list.items.length > 0
        const isOpen = open[list.id] ?? !allDone
        return (
          <section key={list.id} ref={register(list.id)} className="overflow-hidden rounded-lg bg-card">
            <ActionRow
              rounded="rounded-lg"
              onEdit={canManage ? () => openEditList(list) : undefined}
              onDelete={canManage ? () => setDeleteTarget({ kind: "list", listId: list.id, label: list.title }) : undefined}
            >
              <button
                type="button"
                onClick={() => toggleOpen(list.id, isOpen)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-2 bg-card px-4 py-4 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className={cn("size-3 rounded-full", memberBg[list.color])} />
                  <h2 className="font-bold">{list.title}</h2>
                  {allDone ? (
                    <span className="rounded-full bg-member-green/15 px-2 py-0.5 text-[0.75rem] font-semibold text-member-green">
                      Complete
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", memberSoft[list.color])}>
                    {done}/{list.items.length}
                  </span>
                  <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
                </div>
              </button>
            </ActionRow>

            {isOpen ? (
              <>
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {list.items.map((item) => (
                    <li key={item.id}>
                      <ActionRow
                        rounded="rounded-none"
                        editLabel="Rename"
                        onEdit={canChange(item.addedBy) ? () => setItemSheet({ listId: list.id, itemId: item.id, label: item.label }) : undefined}
                        onDelete={canChange(item.addedBy) ? () => setDeleteTarget({ kind: "item", listId: list.id, itemId: item.id, label: item.label }) : undefined}
                      >
                      <button
                        type="button"
                        onClick={() => {
                          toggleItem(list.id, item.id)
                          // Check if all remaining items will be done
                          const willAllBeDone = list.items.filter((i) => i.id !== item.id).every((i) => i.done)
                          if (!item.done && willAllBeDone) {
                            celebrateCompletion("strong")
                          }
                        }}
                        aria-pressed={item.done}
                        className="flex w-full items-center gap-3 bg-card px-4 py-2.5 text-left"
                      >
                          <span
                            className={cn(
                              "flex size-6 items-center justify-center rounded-full border-2 transition-colors",
                              item.done ? cn(memberBg[list.color], "border-transparent text-white") : "border-border text-transparent",
                            )}
                          >
                            <Check className="size-3.5" strokeWidth={3} />
                          </span>
                          <span className={cn("text-sm", item.done && "text-muted-foreground line-through")}>{item.label}</span>
                        </button>
                      </ActionRow>
                    </li>
                  ))}
                  {list.items.length === 0 ? (
                    <li className="px-4 py-3 text-sm text-muted-foreground">No items yet.</li>
                  ) : null}
                </ul>

                {canManage && done > 0 ? (
                  <button
                    type="button"
                    onClick={() => setDeleteTarget({ kind: "clear", listId: list.id, label: list.title, count: done })}
                    className="flex w-full items-center gap-3 border-t border-hairline px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Eraser className="size-4 shrink-0" />
                    Clear {done} checked {done === 1 ? "item" : "items"}
                  </button>
                ) : null}

                {/* Anyone can add an item and change their own; managing lists and others' items needs the Lists permission. */}
                <div className="flex items-center gap-2 border-t border-hairline px-3 py-2.5">
                  <Plus className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    value={drafts[list.id] ?? ""}
                    onChange={(e) => setDrafts((p) => ({ ...p, [list.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && submitDraft(list.id)}
                    placeholder="Add item…"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  {(drafts[list.id] ?? "").trim() ? (
                    <button
                      type="button"
                      onClick={() => submitDraft(list.id)}
                      className="shrink-0 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
                    >
                      Add
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </section>
        )
      })}

      {canManage ? (
        <button
          type="button"
          onClick={openAddList}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <Plus className="size-4" />
          New list
        </button>
      ) : null}

      {/* List add/edit sheet */}
      <BottomSheet
        open={!!listSheet}
        onClose={() => setListSheet(null)}
        title={listSheet?.editingId ? "Edit list" : "New list"}
        footer={
          <button
            type="button"
            onClick={saveList}
            className="w-full rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
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
            className="w-full rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
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
