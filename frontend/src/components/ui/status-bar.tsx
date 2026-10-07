import { cn } from "cn"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { useNow } from "@/hooks/use-clock"
import type { Clock } from "@/lib/clock"
import { NULL_TOKEN, NUMERIC_CLASS } from "@/lib/format"

// The strip at the bottom of every terminal: which environment this is, what time it is where the
// markets are, who is signed in, and whatever the consumer puts in the slots between, a feed health
// strip and a frame monitor as a rule. Every string is the consumer's. The environment badge is a
// safety feature: production reads at a glance, in a word and a tone. The clocks tick on the shared
// one-second clock, so a bar with three of them costs one timer.

export type StatusTone = "up" | "down" | "flat" | "stale" | "expiring" | "primary" | "destructive"

export interface StatusBarEnvironment {
  /** The word: "PRODUCTION", "UAT", "DEV". Printed as is. */
  label: string
  tone?: StatusTone
}

export interface StatusBarClock {
  /** "New York", "London", "Tokyo". */
  label: string
  /** An IANA zone: "America/New_York". */
  zone: string
  /** Show seconds. Default true. */
  seconds?: boolean
  /** Default h23. */
  hourCycle?: "h23" | "h12"
}

export interface StatusBarLabels {
  /** The bar's accessible name. */
  title: string
  environment: string
  user: string
  clocks: string
}

export const DEFAULT_STATUS_BAR_LABELS: StatusBarLabels = {
  title: "Status",
  environment: "Environment",
  user: "Signed in as",
  clocks: "Clocks",
}

export interface StatusBarProps {
  environment?: StatusBarEnvironment
  clocks?: StatusBarClock[]
  /** The signed-in user, as a string to print. */
  user?: string
  /** Your children, left of center. */
  left?: ReactNode
  /** Your children, in the middle. */
  center?: ReactNode
  /** Your children, right of the clocks and the user. */
  right?: ReactNode
  /** The shared one-second clock unless given another. */
  clock?: Clock
  labels?: Partial<StatusBarLabels>
  className?: string
}

/** The environment badge's classes per tone. The label is always the word; the tone is the hint. */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  up: "text-up bg-up-soft",
  down: "text-down bg-down-soft",
  flat: "text-flat bg-flat-soft",
  stale: "text-stale bg-stale-soft",
  expiring: "text-expiring bg-expiring-soft",
  primary: "text-primary bg-primary/15",
  destructive: "text-destructive bg-destructive/15",
}

const formats = new Map<string, Intl.DateTimeFormat | null>()

/** A formatter for a zone, made once; null when the zone is not one the runtime knows. */
export function clockFormat(zone: string, seconds = true, hourCycle: "h23" | "h12" = "h23"): Intl.DateTimeFormat | null {
  const key = `${zone}|${seconds}|${hourCycle}`
  if (!formats.has(key)) {
    try {
      formats.set(key, new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hourCycle }))
    } catch {
      formats.set(key, null)
    }
  }
  return formats.get(key) ?? null
}

/** The time in a zone, or the null token when the zone is not one the runtime knows. */
export function formatClock(ms: number, clock: StatusBarClock): string {
  const format = clockFormat(clock.zone, clock.seconds ?? true, clock.hourCycle ?? "h23")
  return format ? format.format(ms) : NULL_TOKEN
}

function ClockReadout({ clock, source }: { clock: StatusBarClock; source?: Clock }) {
  const now = useNow(source)
  return (
    <span className="flex items-baseline gap-1" data-status-clock={clock.label} title={clock.zone}>
      <span className="text-muted-foreground">{clock.label}</span>
      <time className={NUMERIC_CLASS} dateTime={new Date(now).toISOString()} data-status-time>
        {formatClock(now, clock)}
      </time>
    </span>
  )
}

export function StatusBar({ environment, clocks, user, left, center, right, clock, labels: labelsProp, className }: StatusBarProps) {
  const labels = { ...DEFAULT_STATUS_BAR_LABELS, ...labelsProp }
  return (
    // Nothing in a slot wraps or shrinks under its neighbors: when the bar is narrower than what is in it, the slots wrap onto another line whole.
    <div role="group" aria-label={labels.title} data-slot="tradecn-status-bar" data-environment={environment?.label} className={cn("flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-background px-2 py-0.5 text-xs whitespace-nowrap text-foreground lining-nums tabular-nums", className)}>
      {environment && (
        <Badge variant="outline" className={cn("h-5 shrink-0 border-transparent px-1.5 text-xs font-semibold tracking-wide", environment.tone && STATUS_TONE_CLASS[environment.tone])} data-status-environment={environment.label} data-tone={environment.tone} title={labels.environment}>
          <span className="sr-only">{labels.environment}: </span>
          {environment.label}
        </Badge>
      )}
      {left !== undefined && <div className="flex shrink-0 items-center gap-2" data-status-slot="left">{left}</div>}
      <div className="flex min-w-4 flex-1 items-center justify-center gap-2" data-status-slot="center">
        {center}
      </div>
      {clocks && clocks.length > 0 && (
        <div className="flex shrink-0 items-center gap-3" role="group" aria-label={labels.clocks} data-status-slot="clocks">
          {clocks.map((c) => (
            <ClockReadout key={`${c.label}|${c.zone}`} clock={c} source={clock} />
          ))}
        </div>
      )}
      {user && (
        <span className="shrink-0 truncate" data-status-user={user} title={`${labels.user} ${user}`}>
          <span className="sr-only">{labels.user} </span>
          {user}
        </span>
      )}
      {right !== undefined && <div className="flex shrink-0 items-center gap-2" data-status-slot="right">{right}</div>}
    </div>
  )
}
