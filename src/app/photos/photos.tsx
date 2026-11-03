"use client"

import { useRef, useState } from "react"
import { Heart, ImageIcon, Trash2, Upload } from "lucide-react"
import { OrbitLoader } from "@/components/os/orbit"
import { useStore } from "@/lib/store"
import { api } from "@/lib/api"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"

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

export function PhotosView() {
  const { photos, can, deletePhoto } = useStore()
  const canManage = can("photos" as any)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

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

  const deletingPhoto = deleteTarget ? photos.find((p) => p.id === deleteTarget) : null

  if (photos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 px-4 py-20 text-center">
        <span className="flex size-16 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <ImageIcon className="size-7" />
        </span>
        <div className="space-y-1">
          <p className="font-bold">No photos yet</p>
          <p className="text-pretty text-sm text-muted-foreground">
            Upload family moments to show them on your hub.
          </p>
        </div>
        {canManage ? (
          <>
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {uploading ? <OrbitLoader size={16} /> : <Upload className="size-4" />}
              {uploading ? "Uploading…" : "Upload photos"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
          </>
        ) : null}
      </div>
    )
  }

  const [featured, ...rest] = photos

  return (
    <div className="space-y-4 px-4 py-4">
      {/* Featured / slideshow card */}
      <div className="group relative overflow-hidden rounded-lg">
        <AuthImg
          src={featured.src}
          alt={featured.caption}
          width={800}
          height={500}
          className="h-56 w-full object-cover"
        />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4">
          <p className="text-sm font-semibold text-white">{featured.caption}</p>
          <p className="text-xs text-white/80">Now showing on your hub</p>
        </div>
        <span className="absolute right-3 top-3 rounded-full bg-black/30 px-2 py-1 text-[0.75rem] font-medium text-white">
          Slideshow
        </span>
        {canManage ? (
          <button
            type="button"
            aria-label="Delete photo"
            onClick={() => setDeleteTarget(featured.id)}
            className="absolute left-3 top-3 hit flex size-10 items-center justify-center rounded-full bg-black/45 text-white transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 hover:bg-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Grid */}
      {rest.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          {rest.map((photo) => (
            <div key={photo.id} className="group relative overflow-hidden rounded-md">
              <AuthImg
                src={photo.src}
                alt={photo.caption}
                width={400}
                height={400}
                className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
              />
              <button
                type="button"
                aria-label="Favorite photo"
                className="absolute right-2 top-2 hit flex size-10 items-center justify-center rounded-full bg-black/35 text-white transition-colors hover:text-primary"
              >
                <Heart className="size-4" />
              </button>
              {canManage ? (
                <button
                  type="button"
                  aria-label="Delete photo"
                  onClick={() => setDeleteTarget(photo.id)}
                  className="absolute left-2 top-2 hit flex size-10 items-center justify-center rounded-full bg-black/45 text-white transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 hover:bg-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              ) : null}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 to-transparent p-2">
                <p className="text-xs font-medium text-white">{photo.caption}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* Upload button */}
      {canManage ? (
        <>
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary",
              uploading && "cursor-not-allowed opacity-50",
            )}
          >
            {uploading ? <OrbitLoader size={16} /> : <Upload className="size-4" />}
            {uploading ? "Uploading…" : "Upload photos"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </>
      ) : null}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete photo?"
        message={deletingPhoto ? `"${deletingPhoto.caption}" will be removed from all devices.` : ""}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deletePhoto(deleteTarget)
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}
