import { cn } from "cn"
import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useNow } from "@/hooks/use-clock"
import { createClock, sharedClock, type Clock } from "@/lib/clock"

// A strip that says, for each feed, whether it is connected and how old its data is.
//
// A number that admits it is two seconds old can be worked with; a frozen screen cannot. So every
// feed gets a state, an age, and a tier, and past a threshold the tier says stale. Only the leaves
// subscribe to the clock: the strip and the app around it do not re-render every second.
//
// A feed may also offer actions, the ids the server allows on it (pause, resume, reconnect,
// resubscribe are the usual set) with the consumer's labels, in a menu on the feed. A press is a
// request: the feed shows it pending until its state changes or a while passes, and the tier never
// moves on a click, only on what the feed reports.

export type FeedState = "connected" | "connecting" | "disconnected" | "unknown"
export type FeedLane = "coalesced" | "ordered"
export type Tier = "live" | "aging" | "stale" | "offline" | "closed"

export interface FeedDescriptor {
  id: string
  label: string
  state: FeedState
  /** `coalesced` lanes drop stale ticks and count them; `ordered` lanes never drop and can have gaps. */
  lane: FeedLane
  /** Wall clock of the last message, ms since epoch. */
  lastMessageAt: number | null
  /** Messages dropped so far (coalesced lane). */
  dropped?: number
  /** Last sequence number applied (ordered lane). */
  seq?: number
  /** A sequence gap is open (ordered lane). */
  gap?: { since: number; replaying: boolean } | null
  /** What the server allows on this feed now, by id. No list means nothing may. */
  allowedActions?: readonly string[]
}

export interface FeedAction {
  /** Matched against each feed's `allowedActions`. */
  id: string
  label: string
  /** Given the feed as it was when pressed. A returned promise settles the pending mark when it resolves or rejects. */
  run: (feed: FeedDescriptor) => void | Promise<unknown>
  destructive?: boolean
}

export interface FeedHealthLabels {
  /** The menu button's name. `{feed}` is the feed's label. */
  actions: string
  /** The tooltip's word for an action that is out. */
  pending: string
}

export const DEFAULT_FEED_HEALTH_LABELS: FeedHealthLabels = { actions: "Actions: {feed}", pending: "Pending" }

/** The actions a feed offers now: yours, in your order, kept to the ids in its `allowedActions`. */
export function feedActionsFor(feed: FeedDescriptor, actions: readonly FeedAction[] | undefined): FeedAction[] {
  if (!actions?.length || !feed.allowedActions?.length) return []
  return actions.filter((action) => feed.allowedActions!.includes(action.id))
}

/** An action out on a feed: which, the state the feed was in, and when. It clears when the state moves, when `pendingMs` lapses, or when the run's promise settles. */
export interface PendingFeedAction {
  action: string
  state: FeedState
  since: number
}

export interface StalenessThresholds {
  agingMs: number
  staleMs: number
}

/** Placeholders until the people who trade on the data agree on real ones. */
export const PROVISIONAL_THRESHOLDS: StalenessThresholds = { agingMs: 2000, staleMs: 10_000 }

export interface SessionCalendar {
  status(now: number): "open" | "closed" | "pre" | "post" | "holiday"
}

export const alwaysOpen: SessionCalendar = { status: () => "open" }

/** Pure tiering. A disconnect is offline whatever the hour; a closed session is closed, not stale. */
export function stalenessTier(feed: FeedDescriptor, now: number, thresholds: StalenessThresholds = PROVISIONAL_THRESHOLDS, session: SessionCalendar = alwaysOpen): Tier {
  if (feed.state === "disconnected") return "offline"
  const status = session.status(now)
  if (status === "closed" || status === "holiday") return "closed"
  if (feed.lastMessageAt === null) return "aging"
  const age = now - feed.lastMessageAt
  if (age < thresholds.agingMs) return "live"
  if (age < thresholds.staleMs) return "aging"
  return "stale"
}

/** "now", "12s", "3m", "2h". */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "–"
  if (ms < 1000) return "now"
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

// The clock lives in lib/clock so a countdown ticks on the same interval. Exported from here still, so nothing that imported it moves.
export { createClock }
export type { Clock }

const TIER_CLASS: Record<Tier, string> = {
  live: "text-foreground",
  aging: "text-stale/80",
  stale: "bg-stale-soft text-stale",
  offline: "text-destructive",
  closed: "text-muted-foreground",
}

const STATE_DOT: Record<FeedState, string> = {
  connected: "bg-up",
  connecting: "animate-pulse bg-stale",
  disconnected: "bg-destructive",
  unknown: "bg-muted-foreground",
}

export interface FeedAgeProps {
  feed: FeedDescriptor
  clock?: Clock
  className?: string
}

/** The age of a feed's data, ticking once a second. Hidden from assistive tech; the strip announces tier changes instead. */
export function FeedAge({ feed, clock, className }: FeedAgeProps) {
  const now = useNow(clock ?? sharedClock())
  return (
    <span aria-hidden data-numeric="" className={cn("lining-nums tabular-nums", className)}>
      {formatAge(feed.lastMessageAt === null ? null : Math.max(0, now - feed.lastMessageAt))}
    </span>
  )
}

interface ItemProps {
  feed: FeedDescriptor
  thresholds: StalenessThresholds
  session: SessionCalendar
  clock: Clock
  compact: boolean
  actions: readonly FeedAction[]
  pending: PendingFeedAction | undefined
  labels: FeedHealthLabels
  onRun: (feed: FeedDescriptor, action: FeedAction) => void
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "")

function FeedItem({ feed, thresholds, session, clock, compact, actions, pending, labels, onRun }: ItemProps) {
  const now = useNow(clock)
  const tier = stalenessTier(feed, now, thresholds, session)
  const offered = feedActionsFor(feed, actions)
  const pendingLabel = pending ? (actions.find((a) => a.id === pending.action)?.label ?? pending.action) : null
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          data-feed={feed.id}
          data-tier={tier}
          data-state={feed.state}
          data-pending={pending?.action}
          className={cn("inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40", TIER_CLASS[tier])}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", STATE_DOT[feed.state])} />
          <span className="font-medium">{feed.label}</span>
          {!compact && (
            <Badge variant="outline" className={cn("h-4 px-1 text-xs uppercase", TIER_CLASS[tier])}>
              {tier}
            </Badge>
          )}
          <FeedAge feed={feed} clock={clock} />
          {feed.lane === "coalesced" && Boolean(feed.dropped) && <span className="text-muted-foreground lining-nums tabular-nums">{`drop ${feed.dropped!.toLocaleString()}`}</span>}
          {feed.lane === "ordered" && feed.gap && (
            <span className="inline-flex items-center gap-1 text-stale">
              {feed.gap.replaying && <Spinner className="size-3" />}
              {`gap ${formatAge(Math.max(0, now - feed.gap.since))}`}
            </span>
          )}
          {/* An action out on the feed: the spinner and the word; the tier is untouched. */}
          {pending && (
            <span data-feed-pending={pending.action} className="inline-flex items-center gap-1 text-muted-foreground">
              <Spinner className="size-3" />
              {pendingLabel}
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>
          <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-left lining-nums tabular-nums">
            <span>State</span>
            <span>{feed.state}</span>
            <span>Data</span>
            <span>{tier}</span>
            <span>Last message</span>
            <span>{feed.lastMessageAt === null ? "–" : new Date(feed.lastMessageAt).toLocaleTimeString()}</span>
            {pending && (
              <>
                <span>{labels.pending}</span>
                <span>{pendingLabel}</span>
              </>
            )}
          {feed.lane === "ordered" && feed.seq !== undefined && (
            <>
              <span>Sequence</span>
              <span>{feed.seq.toLocaleString()}</span>
            </>
          )}
          {feed.lane === "coalesced" && (
            <>
              <span>Dropped</span>
              <span>{(feed.dropped ?? 0).toLocaleString()}</span>
            </>
          )}
            {feed.gap && (
              <>
                <span>Gap</span>
                <span>{feed.gap.replaying ? "replaying" : "open"}</span>
              </>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
      {/* The menu, only for a feed the server allows something on. Its items are held while an action is out. */}
      {offered.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={fill(labels.actions, { feed: feed.label })}
            data-feed-actions={feed.id}
            className="rounded px-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <circle cx="5" cy="1.5" r="1.2" />
              <circle cx="5" cy="5" r="1.2" />
              <circle cx="5" cy="8.5" r="1.2" />
            </svg>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {offered.map((action) => (
              <DropdownMenuItem key={action.id} disabled={Boolean(pending)} data-feed-action={action.id} className={cn(action.destructive && "text-destructive")} onClick={() => onRun(feed, action)}>
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}

function Announcer({ feeds, thresholds, session, clock }: Pick<ItemProps, "thresholds" | "session" | "clock"> & { feeds: FeedDescriptor[] }) {
  const now = useNow(clock)
  const tiers = feeds.map((f) => `${f.id}=${stalenessTier(f, now, thresholds, session)}`).join("|")
  const [seen, setSeen] = useState(tiers)
  const [message, setMessage] = useState("")
  // Derived state, set during render: speak only when a tier changes, never on a plain tick.
  if (seen !== tiers) {
    const before = new Map(seen.split("|").map((p) => p.split("=") as [string, string]))
    const changes = feeds
      .map((f) => ({ f, tier: stalenessTier(f, now, thresholds, session) }))
      .filter(({ f, tier }) => before.get(f.id) !== tier)
      .map(({ f, tier }) => `${f.label} ${tier}${tier === "stale" || tier === "aging" ? `, ${formatAge(f.lastMessageAt === null ? null : now - f.lastMessageAt)}` : ""}`)
    setSeen(tiers)
    if (changes.length) setMessage(changes.join(". "))
  }
  return (
    <span aria-live="polite" className="sr-only">
      {message}
    </span>
  )
}

export interface FeedHealthProps {
  feeds: FeedDescriptor[]
  thresholds?: StalenessThresholds
  session?: SessionCalendar
  clock?: Clock
  /** Hide the tier pill; the color and the age still show. */
  compact?: boolean
  /** What can be done to a feed, in your order and your words. A feed offers only the ids in its `allowedActions`, in a menu of its own. */
  actions?: readonly FeedAction[]
  /** How long an action shows pending when neither the feed's state nor the run's promise settles it. Default 5000. */
  pendingMs?: number
  labels?: Partial<FeedHealthLabels>
  className?: string
}

const NO_ACTIONS: readonly FeedAction[] = []
const NO_PENDING: Readonly<Record<string, PendingFeedAction>> = {}

export function FeedHealth({ feeds, thresholds = PROVISIONAL_THRESHOLDS, session = alwaysOpen, clock, compact = false, actions = NO_ACTIONS, pendingMs = 5000, labels: labelsProp, className }: FeedHealthProps) {
  const c = clock ?? sharedClock()
  const labels = { ...DEFAULT_FEED_HEALTH_LABELS, ...labelsProp }
  // Actions out, by feed id. Derived state settled during render: a feed whose state moved since the press is answered.
  const [pending, setPending] = useState(NO_PENDING)
  let settled: Record<string, PendingFeedAction> | null = null
  for (const [id, entry] of Object.entries(pending)) {
    const feed = feeds.find((f) => f.id === id)
    if (feed && feed.state === entry.state) continue
    settled ??= { ...pending }
    delete settled[id]
  }
  const live = settled ?? pending
  if (settled) setPending(settled)
  const latest = useRef({ actions, pendingMs })
  useEffect(() => {
    latest.current = { actions, pendingMs }
  })
  const clear = (id: string, since: number) => setPending((current) => (current[id]?.since === since ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)) : current))
  const run = (feed: FeedDescriptor, action: FeedAction) => {
    // Asked of the feed as it is now, not as it was drawn.
    if (!feed.allowedActions?.includes(action.id) || live[feed.id]) return
    const since = c.now()
    setPending((current) => ({ ...current, [feed.id]: { action: action.id, state: feed.state, since } }))
    setTimeout(() => clear(feed.id, since), latest.current.pendingMs)
    let result: void | Promise<unknown>
    try {
      result = action.run(feed)
    } catch {
      clear(feed.id, since)
      return
    }
    if (result && typeof (result as Promise<unknown>).then === "function") (result as Promise<unknown>).then(() => clear(feed.id, since), () => clear(feed.id, since))
  }
  // Radix tooltips throw without a provider above them; Base UI tooltips do not need one. Every style
  // exports TooltipProvider, so the strip brings its own and works in a consumer that never added one.
  return (
    <TooltipProvider>
      <div role="group" aria-label="Feed health" data-slot="tradecn-feed-health" className={cn("flex items-center gap-1 lining-nums tabular-nums", className)}>
        {feeds.map((feed, i) => (
          <span key={feed.id} className="inline-flex items-center gap-1">
            {i > 0 && <Separator orientation="vertical" className="h-3" />}
            <FeedItem feed={feed} thresholds={thresholds} session={session} clock={c} compact={compact} actions={actions} pending={live[feed.id]} labels={labels} onRun={run} />
          </span>
        ))}
        <Announcer feeds={feeds} thresholds={thresholds} session={session} clock={c} />
      </div>
    </TooltipProvider>
  )
}
