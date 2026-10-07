export interface Clock {
  subscribe(cb: () => void): () => void
  /** The time of the last tick; stable between ticks. */
  now(): number
}

/** One interval shared by every subscriber; it runs only while someone is listening. */
export function createClock(intervalMs = 1000, source: () => number = Date.now): Clock {
  let current = source()
  let timer: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<() => void>()
  return {
    now: () => current,
    subscribe(cb) {
      listeners.add(cb)
      if (timer === null) {
        current = source()
        timer = setInterval(() => {
          current = source()
          for (const l of listeners) l()
        }, intervalMs)
      }
      return () => {
        listeners.delete(cb)
        if (!listeners.size && timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
    },
  }
}

let shared: Clock | null = null

/** The one-second clock every tradecn item ticks on unless it is given another. Made on first use. */
export function sharedClock(): Clock {
  return (shared ??= createClock(1000))
}
