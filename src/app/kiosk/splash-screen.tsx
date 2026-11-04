"use client"

import { MOTTO, Wordmark } from "@/components/os/wordmark"

/**
 * Boot screen.
 *
 * Shown the instant the appliance powers on while we load local device state.
 * The same frame the OS boot screen ends on (os/tools/make-splash.swift): the
 * wordmark and motto centred, in ink only, sized to the panel's height.
 * Nothing of Linux, ever.
 */
export function SplashScreen({ message = "Starting up" }: { message?: string }) {
  return (
    <main className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-background text-foreground">
      <Wordmark plain className="block text-[18.52vh]" />
      <p className="mt-[2.41vh] font-display text-[4.26vh] italic leading-[1.2] text-muted-foreground">{MOTTO}</p>
      <span className="sr-only">{message}</span>
    </main>
  )
}
