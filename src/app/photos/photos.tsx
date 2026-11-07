"use client"

import { useRef, useState } from "react"
import { Check, ImageIcon, Play, Smartphone, Trash2, Upload } from "lucide-react"
import { WaveLoader } from "@/components/os/loading"
import { useStore } from "@/lib/store"
import { api } from "@/lib/api"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { HeaderSlot } from "@/components/ui/reusables/header-slot"

import { useAuthenticatedSrc } from "@/hooks/use-authenticated-src"
import { cn } from "@/lib/utils"

/** Fetches the image with the auth token and renders it via a blob URL. */
function AuthImg({
  src,
  alt,
  className,
  width,
  height,
}: {
  src: string
  alt: string
  className?: string
  width?: number
  height?: number
}) {
  const blobSrc = useAuthenticatedSrc(src)
  return blobSrc ? (
    <img src={blobSrc} alt={alt} className={className} width={width} height={height} />
  ) : (
    <div
      role="img"
      aria-label={alt || "Photo loading"}
      className={cn("skel", className)}
      style={width && height ? { aspectRatio: `${width}/${height}` } : undefined}
    />
  )
}

/** Asks the shell to start the slideshow now instead of waiting for the idle timer. */
export const SLIDESHOW_EVENT = "solora:slideshow"

/**
 * The family's photos across the wall: the one showing now, big, beside the
 * rest. Deleting is a mode you switch on (Select), never a trash can that only
 * shows on hover, since a wall has no hover.
 */
export function PhotosView() {
  const { photos, can, deletePhoto } = useStore()
  const canManage = can("photos" as any)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue
        await api.uploadPhoto(file)
      }
    } catch (err) {
      console.error("[photos] upload error:", err)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const stopSelecting = () => {
    setSelecting(false)
    setPicked([])
  }
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  const upload = canManage ? (
    <>
      <button
        type="button"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
        className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-secondary px-4 text-sm font-semibold disabled:opacity-50"
      >
        {uploading ? <WaveLoader size={16} /> : <Upload className="size-4" />}
        {uploading ? "Uploading…" : "Upload"}
      </button>
      <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
    </>
  ) : null

  if (photos.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-start justify-end gap-5 pb-10">
        <span className="flex size-14 items-center justify-center rounded-[14px] bg-secondary text-muted-foreground">
          <ImageIcon className="size-6" />
        </span>
        <div className="space-y-2">
          <p className="font-display text-5xl leading-none">No photos yet.</p>
          <p className="max-w-md text-pretty text-muted-foreground">
            Add them from the Solora app on your phone, or pinch a photo up from your phone to throw it on the wall.
          </p>
        </div>
        {upload}
      </div>
    )
  }

  const [featured, ...rest] = photos

  const tile = (photo: (typeof photos)[number], big = false) => {
    const on = picked.includes(photo.id)
    return (
      <button
        key={photo.id}
        type="button"
        disabled={!selecting}
        aria-pressed={selecting ? on : undefined}
        aria-label={selecting ? `Select ${photo.caption || "photo"}` : photo.caption || "Photo"}
        onClick={() => togglePick(photo.id)}
        className={cn(
          "relative overflow-hidden rounded-[20px] border border-hairline bg-card text-left disabled:cursor-default",
          big ? "min-h-0 flex-1" : "aspect-square",
          selecting && on && "ring-[3px] ring-foreground ring-offset-2 ring-offset-background",
        )}
      >
        <AuthImg src={photo.src} alt={photo.caption} className="absolute inset-0 size-full object-cover" />
        {big || photo.caption ? (
          <span className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] rounded-[12px] bg-card px-3 py-1.5">
            {photo.caption ? <span className="block truncate text-sm font-medium">{photo.caption}</span> : null}
            {big ? <span className="block text-xs text-muted-foreground">Now on the wall</span> : null}
          </span>
        ) : null}
        {selecting ? (
          <span
            className={cn(
              "absolute right-3 top-3 flex size-7 items-center justify-center rounded-full border-2",
              on ? "border-transparent bg-foreground text-background" : "border-white bg-black/20",
            )}
          >
            {on ? <Check className="size-4" strokeWidth={3} /> : null}
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <HeaderSlot name="extras">
        {selecting ? (
          <>
            <button type="button" onClick={stopSelecting} className="os-button-quiet !min-h-11 !text-foreground">
              Cancel
            </button>
            <button
              type="button"
              disabled={picked.length === 0}
              onClick={() => setConfirming(true)}
              className="flex h-11 items-center gap-2 rounded-full bg-destructive px-5 text-sm font-semibold text-white disabled:opacity-40"
            >
              <Trash2 className="size-4" />
              Delete {picked.length || ""}
            </button>
          </>
        ) : (
          <>
            {canManage ? (
              <button type="button" onClick={() => setSelecting(true)} className="flex h-11 items-center rounded-full border border-hairline bg-card px-4 text-sm font-medium">
                Select
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(SLIDESHOW_EVENT))}
              className="flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground"
            >
              <Play className="size-4 fill-current" />
              Slideshow
            </button>
          </>
        )}
      </HeaderSlot>

      <div className="flex min-h-[28rem] flex-[1.15] flex-col gap-3">
        {tile(featured, true)}
        <div className="os-card flex items-center gap-4 px-4 py-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-secondary">
            <Smartphone className="size-5" strokeWidth={1.7} />
          </span>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            <span className="block text-[0.95rem] font-medium text-foreground">Add from your phone</span>
            Use the Solora app, or pinch a photo up from your phone to throw it on the wall.
          </p>
          {upload}
        </div>
      </div>

      {rest.length > 0 ? (
        <div className="grid flex-1 auto-rows-min grid-cols-3 content-start gap-3">{rest.map((p) => tile(p))}</div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={picked.length === 1 ? "Delete photo?" : `Delete ${picked.length} photos?`}
        message="They come off the wall and every phone in the family."
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          picked.forEach((id) => deletePhoto(id))
          setConfirming(false)
          stopSelecting()
        }}
      />
    </div>
  )
}
