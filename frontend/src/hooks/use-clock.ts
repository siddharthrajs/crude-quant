import { useSyncExternalStore } from "react"
import { sharedClock, type Clock } from "@/lib/clock"

/** The clock's time. The caller re-renders on each tick and on nothing else. The shared one-second clock unless given another. */
export function useNow(clock?: Clock): number {
  const c = clock ?? sharedClock()
  return useSyncExternalStore(c.subscribe, c.now, c.now)
}
