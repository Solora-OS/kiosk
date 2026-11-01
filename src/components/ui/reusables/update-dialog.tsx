"use client"

import { useSyncExternalStore, useState, useEffect } from "react"
import {
  DownloadCloud,
  ShieldCheck,
  Calendar,
  Hash,
  FileText,
  Loader2,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  getPendingUpdate,
  subscribeUpdate,
  dismissUpdate,
  installUpdate,
} from "@/lib/hub"

async function getTauriVersion(): Promise<string | null> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch {
    return null
  }
}

function useCurrentVersion(): string {
  const [ver, setVer] = useState<string>("—")
  useEffect(() => {
    void getTauriVersion().then((v) => { if (v) setVer(v) })
  }, [])
  return ver
}

function InfoRow({
  icon: Icon,
  label,
  value,
  mono = false,
}: {
  icon: typeof Hash
  label: string
  value: string | null | undefined
  mono?: boolean
}) {
  if (!value) return null
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-0">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("mt-0.5 break-all text-sm leading-snug text-foreground", mono && "font-mono text-[0.8rem]")}>
          {value}
        </p>
      </div>
    </div>
  )
}

/**
 * Auto-update available dialog.
 * Opens automatically when checkForUpdates() finds a new version.
 */
export function UpdateDialog() {
  const update = useSyncExternalStore(subscribeUpdate, getPendingUpdate, getPendingUpdate)
  const currentVersion = useCurrentVersion()
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = !!update || installing

  const handleInstall = async () => {
    setError(null)
    setInstalling(true)
    try {
      await installUpdate()
      dismissUpdate()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed. Please try again.")
      setInstalling(false)
    }
  }

  const handleDismiss = () => {
    if (installing) return
    dismissUpdate()
    setError(null)
  }

  const formattedDate = update?.date
    ? (() => {
        try {
          return new Date(update.date).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })
        } catch {
          return update.date
        }
      })()
    : null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleDismiss() }}>
      <DialogContent className="max-w-sm gap-0 p-0 overflow-hidden">
        {/* Header — same bg-card as body, no split */}
        <div className="px-6 pt-6 pb-4 border-b border-hairline">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Update Available</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground mt-0.5">
              A new version of Solora is ready to install.
            </DialogDescription>
          </DialogHeader>

          {/* Version transition row */}
          <div className="mt-3 flex items-center gap-2">
            <span className="rounded-full bg-secondary px-3 py-1 text-sm font-mono font-semibold text-muted-foreground">
              v{currentVersion}
            </span>
            <span className="text-muted-foreground text-xs">→</span>
            <span className="rounded-full bg-primary px-3 py-1 text-sm font-mono font-semibold text-primary-foreground">
              v{update?.version ?? "…"}
            </span>
            {update?.signed && (
              <span className="ml-auto flex items-center gap-1 rounded-full bg-member-green/15 px-2.5 py-1 text-[0.75rem] font-semibold text-member-green">
                <ShieldCheck className="size-3" />
                Signed
              </span>
            )}
          </div>
        </div>

        {/* Info rows */}
        <div className="px-6 py-1">
          <InfoRow icon={Calendar} label="Release date" value={formattedDate} />
          <InfoRow icon={Hash} label="SHA-256" value={update?.sha256} mono />
          {update?.body && (
            <div className="flex items-start gap-3 py-2.5">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                <FileText className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-muted-foreground">Release notes</p>
                <div className="mt-1 max-h-32 overflow-y-auto overscroll-contain">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{update.body}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <p className="mx-6 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
            {error}
          </p>
        )}

        {/* Footer */}
        <DialogFooter className="gap-2 px-6 py-4 border-t border-hairline">
          <Button variant="outline" onClick={handleDismiss} disabled={installing} className="flex-1">
            Later
          </Button>
          <Button onClick={() => void handleInstall()} disabled={installing} className="flex-1 gap-2">
            {installing ? (
              <>
                <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
                Installing…
              </>
            ) : (
              <>
                <DownloadCloud className="size-4" data-icon="inline-start" />
                Install & Restart
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
