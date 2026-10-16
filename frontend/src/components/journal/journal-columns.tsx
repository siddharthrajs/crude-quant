import type { ColumnDef } from "@/components/ui/data-grid"
import type { AuditEvent } from "@/components/ui/audit-trail"
import { directionClass, directionOf } from "@/hooks/use-flash"
import { NULL_TOKEN, formatPrice, formatSignedUsd } from "@/lib/format"
import type { JournalEntry } from "@/lib/positions-api"

/** One closed trade, shaped for `AuditTrail`: the DB row (`raw`) plus what `AuditEvent` needs for the
 * grid to render at all and for the side pane to have something to show. */
export interface JournalGridRow extends AuditEvent {
  raw: JournalEntry
}

let dateTimeFormat: Intl.DateTimeFormat | null = null
export function formatDateTime(ms: number): string {
  dateTimeFormat ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
  return dateTimeFormat.format(ms)
}

const twoDecimals = (value: number) => formatPrice(value, { kind: "decimal", decimals: 2 })
const usd = (value: number) => formatSignedUsd(value, { decimals: 2 })

/** A number as the plain text a spreadsheet reads as a number (ASCII minus, no currency symbol); blank for none. */
const csvNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "")

/** "2026-10-13 16:05:54" in local time: sorts as text and Excel reads it as a date, unlike "Oct 13, 16:05:54" with no year. */
function csvDateTime(v: unknown): string {
  if (typeof v !== "number") return ""
  const d = new Date(v)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** A closed position's entry, exit, and outcome, read as the side pane's "changes": what the trade's
 * price and P&L moved from open to close. */
export function toJournalChanges(entry: JournalEntry): AuditEvent["changes"] {
  return [
    { field: "side", to: entry.side },
    { field: "size", to: entry.size },
    { field: "price", from: entry.average_price, to: entry.exit_price },
    { field: "realized_pnl", to: entry.realized_pnl },
  ]
}

export function toJournalRow(entry: JournalEntry): JournalGridRow {
  return {
    id: String(entry.id),
    at: new Date(entry.closed_at).getTime(),
    event: entry.strategy_label,
    by: entry.owner_username,
    changes: toJournalChanges(entry),
    raw: entry,
  }
}

/** Every column named after its `trade_journal_entries` field, in place of `AuditTrail`'s generic
 * time/event/message defaults -- this trail is one thing (a closed trade), not an arbitrary event
 * stream, so its columns say so. */
export function journalGridColumns(): ColumnDef<JournalGridRow>[] {
  const price = (v: unknown) => (typeof v === "number" ? twoDecimals(v) : NULL_TOKEN)
  const signed = (v: unknown) => (typeof v === "number" ? usd(v) : NULL_TOKEN)
  const dt = (v: unknown) => (typeof v === "number" ? formatDateTime(v) : NULL_TOKEN)
  return [
    { key: "product", header: "Product", width: 84, sortable: true, flash: false, accessor: (r) => r.raw.product },
    { key: "strategy_label", header: "Strategy", width: 116, frozen: "left", sortable: true, flash: false, accessor: (r) => r.raw.strategy_label, cell: ({ row }) => <span className="font-semibold">{row.raw.strategy_label}</span> },
    { key: "side", header: "Side", width: 72, sortable: true, flash: false, accessor: (r) => r.raw.side, format: (v) => (v === "long" ? "Long" : "Short") },
    { key: "size", header: "Size", width: 72, numeric: true, sortable: true, flash: false, accessor: (r) => r.raw.size },
    { key: "average_price", header: "Entry Price", width: 96, numeric: true, sortable: true, flash: false, accessor: (r) => r.raw.average_price, format: price, csv: csvNumber },
    { key: "exit_price", header: "Exit Price", width: 96, numeric: true, sortable: true, flash: false, accessor: (r) => r.raw.exit_price, format: price, csv: csvNumber },
    {
      key: "realized_pnl",
      header: "Realized P&L",
      width: 112,
      numeric: true,
      sortable: true,
      accessor: (r) => r.raw.realized_pnl,
      format: signed,
      csv: csvNumber,
      cell: ({ row }) => <span className={directionClass(directionOf(0, row.raw.realized_pnl))}>{signed(row.raw.realized_pnl)}</span>,
    },
    { key: "stop_loss", header: "Stop Loss", width: 88, numeric: true, sortable: true, flash: false, accessor: (r) => r.raw.stop_loss ?? null, format: price, csv: csvNumber },
    { key: "take_profit", header: "Take Profit", width: 88, numeric: true, sortable: true, flash: false, accessor: (r) => r.raw.take_profit ?? null, format: price, csv: csvNumber },
    { key: "owner_username", header: "Trader", width: 96, sortable: true, flash: false, accessor: (r) => r.raw.owner_username },
    { key: "opened_at", header: "Opened At", width: 148, sortable: true, flash: false, accessor: (r) => new Date(r.raw.opened_at).getTime(), format: dt, csv: csvDateTime },
    { key: "closed_at", header: "Closed At", width: 148, sortable: true, flash: false, accessor: (r) => new Date(r.raw.closed_at).getTime(), format: dt, csv: csvDateTime },
  ]
}
