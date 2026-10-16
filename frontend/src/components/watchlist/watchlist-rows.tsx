// The Watchlist's row model and grid columns, kept apart from the tab component (and shared with the Dashboard's
// watchlist panel): what a saved combination looks like against its live quote, and how that is printed.
//
// Each item has two base ranges measured over past years: its price LEVEL and its DAILY CHANGE. The level range is
// judged on the live price, the daily-change range on the live move since the previous settle; when either is left
// the row's `state` is "above" or "below". A price built on a market too wide to trust is shown but never judged.

import type { ColumnDef } from "@/components/ui/data-grid"
import { toTick, TICK } from "@/lib/seasonality"
import type { WatchRange, WatchlistItem } from "@/lib/watchlist-api"
import type { LiveQuote } from "@/lib/watchlist-pricing"
/** The row's overall verdict. "above" / "below" mean a break of at least one range (the Dashboard panel reads it that way). */
export type WatchState = "inside" | "above" | "below" | "wide" | "nofeed" | "noref"

/** One range against its live quantity; "na" when the item has no such range or the row is not being judged. */
type RangeState = "inside" | "above" | "below" | "na"

export interface WatchRow {
  id: string
  name: string
  /** The combination's live price (mid), on the tick. */
  live: number | null
  /** Its move since the previous settle, on the tick: what the daily-change range is judged on. */
  value: number | null
  levelLo: number | null
  levelHi: number | null
  levelState: RangeState
  changeLo: number | null
  changeHi: number | null
  changeState: RangeState
  state: WatchState
  /** Ticks past the edge of the range that was broken, or from the nearest edge when inside. */
  edgeTicks: number | null
  /** Total bid/ask width of the quotes the price is built from, in ticks. */
  widthTicks: number | null
  basis: string
  asOf: string
}

/** A price built on quotes wider than this in total (0.15 = 15 ticks) is not trusted to say a range was broken. */
const MAX_WIDTH = 0.15
const NULL = "—"
const px = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : NULL)
const signedPx = (v: number | null) => (v === null ? NULL : v > 0 ? `+${px(v)}` : px(v))

/** A live quantity against one range, both on the 0.01 tick (the live value is snapped to it first). */
function judge(value: number | null, range: WatchRange | null): { state: RangeState; edgeTicks: number | null } {
  if (!range || value === null) return { state: "na", edgeTicks: null }
  const v = toTick(value)
  if (v > range.hi) return { state: "above", edgeTicks: Math.round((v - range.hi) / TICK) }
  if (v < range.lo) return { state: "below", edgeTicks: Math.round((range.lo - v) / TICK) }
  return { state: "inside", edgeTicks: Math.round(Math.min(range.hi - v, v - range.lo) / TICK) }
}

export function toRow(item: WatchlistItem, quote: LiveQuote | null): WatchRow {
  const { ranges, settings } = item
  const trusted = quote !== null && quote.width <= MAX_WIDTH
  const level = judge(trusted ? quote.price : null, ranges.level)
  const change = judge(trusted ? quote.move : null, ranges.change)

  let state: WatchState
  let edgeTicks: number | null = null
  if (!quote) state = "nofeed"
  else if (!trusted) state = "wide"
  else {
    const judged = [level, change].filter((j) => j.state !== "na")
    const broken = judged.find((j) => j.state === "above" || j.state === "below")
    if (broken) {
      state = broken.state as WatchState
      edgeTicks = broken.edgeTicks
    } else if (judged.length === 0) state = "noref"
    else {
      state = "inside"
      edgeTicks = Math.min(...judged.map((j) => j.edgeTicks as number))
    }
  }

  return {
    id: String(item.id),
    name: item.name,
    live: quote ? toTick(quote.price) : null,
    value: quote && quote.move !== null ? toTick(quote.move) : null,
    levelLo: ranges.level?.lo ?? null,
    levelHi: ranges.level?.hi ?? null,
    levelState: level.state,
    changeLo: ranges.change?.lo ?? null,
    changeHi: ranges.change?.hi ?? null,
    changeState: change.state,
    state,
    edgeTicks,
    widthTicks: quote ? Math.round(quote.width / TICK) : null,
    basis: `±${settings.sigma}σ · ${settings.basis === "others" ? "other years" : "all years"}${settings.remove_spikes ? " · spikes removed" : ""}`,
    asOf: item.range_as_of ?? NULL,
  }
}

const STATE_LABEL: Record<WatchState, string> = {
  inside: "● Inside",
  above: "▲ ABOVE range",
  below: "▼ BELOW range",
  wide: "Quote too wide",
  nofeed: "No live price",
  noref: "Cannot judge yet",
}

const MARK: Record<RangeState, string> = { inside: "", above: " ▲", below: " ▼", na: "" }

/** One range cell: "lo → hi", with the direction of the break marked on it when this is the range that was broken. */
function rangeCell(lo: number | null, hi: number | null, state: RangeState, what: string, row: WatchRow) {
  if (lo === null || hi === null) return <span className="text-muted-foreground" title={`No ${what} range could be measured for this combination`}>{NULL}</span>
  return (
    <span className={state === "above" || state === "below" ? "font-bold underline decoration-dotted" : undefined} title={`${what} range · ${row.basis} · data to ${row.asOf}`}>
      {px(lo)} → {px(hi)}
      {MARK[state]}
    </span>
  )
}

export const COLUMNS: ColumnDef<WatchRow>[] = [
  { key: "name", header: "Combination", width: 330, frozen: "left", sortable: true, accessor: (r) => r.name, cell: ({ row }) => <span className="font-mono font-semibold">{row.name}</span> },
  // The live price, with its move since the previous settle (what the daily-change range is judged on) in brackets.
  {
    key: "live",
    header: "Live",
    width: 150,
    numeric: true,
    sortable: true,
    accessor: (r) => r.live,
    cell: ({ row }) => (
      <span title="Live price (mid); in brackets, its move since the previous settle">
        {px(row.live)}
        {row.value !== null && <span className="ml-1 text-muted-foreground">({signedPx(row.value)})</span>}
      </span>
    ),
  },
  {
    key: "changeRange",
    header: "Daily change range",
    width: 160,
    numeric: true,
    flash: false,
    accessor: (r) => r.changeLo,
    cell: ({ row }) => rangeCell(row.changeLo, row.changeHi, row.changeState, "Daily change", row),
  },
  {
    key: "levelRange",
    header: "Level range",
    width: 160,
    numeric: true,
    flash: false,
    accessor: (r) => r.levelLo,
    cell: ({ row }) => rangeCell(row.levelLo, row.levelHi, row.levelState, "Level", row),
  },
  {
    key: "state",
    header: "Status",
    width: 150,
    sortable: true,
    flash: false,
    accessor: (r) => r.state,
    cell: ({ row }) => (
      <span
        className="font-semibold"
        title={row.widthTicks === null ? undefined : `Quote width ${row.widthTicks} ticks${row.edgeTicks === null ? "" : row.state === "inside" ? `; ${row.edgeTicks} ticks from the nearest edge` : `; ${row.edgeTicks} ticks beyond the edge`}`}
      >
        {STATE_LABEL[row.state]}
      </span>
    ),
  },
  {
    key: "breaks",
    header: "Broken",
    width: 150,
    flash: false,
    accessor: (r) => `${r.changeState}/${r.levelState}`,
    cell: ({ row }) => {
      const broken = [row.changeState === "above" || row.changeState === "below" ? `Daily ${row.changeState === "above" ? "▲" : "▼"}` : null, row.levelState === "above" || row.levelState === "below" ? `Level ${row.levelState === "above" ? "▲" : "▼"}` : null].filter(Boolean)
      return <span>{broken.length ? broken.join(" · ") : NULL}</span>
    },
  },
]
