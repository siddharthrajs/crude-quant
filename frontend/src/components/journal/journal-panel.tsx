import { useEffect, useState } from "react"
import { formatDateTime, journalGridColumns, toJournalRow, type JournalGridRow } from "@/components/journal/journal-columns"
import { JournalAnalyticsPanel } from "@/components/journal/journal-analytics"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { AuditTrail } from "@/components/ui/audit-trail"
import { Button } from "@/components/ui/button"
import type { SortState } from "@/components/ui/data-grid"
import { useAuth } from "@/hooks/use-auth"
import { NULL_TOKEN, formatPrice, formatSignedUsd } from "@/lib/format"
import { deleteJournalEntries, getJournal, getMemberJournal, type BookMode, type BookScope, type JournalEntry } from "@/lib/positions-api"
import { createRowStore, type RowId } from "@/lib/row-store"

/** How the side pane prints a "changes" field's before/after value -- `price` and `realized_pnl`
 * need their own units; everything else is a plain string. */
function formatChangeValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return NULL_TOKEN
  if (field === "realized_pnl" && typeof value === "number") return formatSignedUsd(value, { decimals: 2 })
  if (field === "price" && typeof value === "number") return formatPrice(value, { kind: "decimal", decimals: 2 })
  if (field === "side") return value === "long" ? "Long" : "Short"
  return String(value)
}

function downloadCsv(csv: string, filename: string) {
  // The BOM makes Excel read the file as UTF-8 instead of guessing a legacy code page.
  const blob = new Blob([String.fromCharCode(0xfeff), csv], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export interface JournalPanelProps {
  scope: BookScope
  /** Manager view: show this member's journal (null = every member combined) instead of `scope`'s
   * book, read-only -- no row selection, so nothing can be deleted. */
  member?: { id: number | null }
  /** Whether this sub-tab is the one currently showing. The panel stays mounted when the user
   * switches away (see `journal-tab.tsx`), and closing a position happens from the separate
   * Positions tab, so a fetch on mount alone would miss every trade closed since -- refetch each
   * time this flips back to true instead. */
  active: boolean
  label: string
  mode?: BookMode
}

/** One book's trade journal: every closed trade, read through `AuditTrail`'s grid on the event "the
 * position closed" -- entry, exit, and the P&L it left, per trade -- with `JournalAnalyticsPanel`
 * standing in for the grid's usual per-row changes pane, since every row here is the same kind of
 * event and a summary across all of them is more useful than a diff of one or two. Rows can be
 * checked and deleted from the journal (the record only -- the underlying closed position stays put);
 * everything else is read-only, since a trade otherwise lands here only via `POST
 * /api/positions/{id}/close`. */
export function JournalPanel({ scope, member, active, label, mode = "live" }: JournalPanelProps) {
  const memberId = member ? member.id : undefined
  const { token } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [store] = useState(() => createRowStore<JournalGridRow>({ getRowId: (r) => r.id, lane: "ordered" }))
  const [columns] = useState(() => journalGridColumns())
  const [selection, setSelection] = useState<ReadonlySet<RowId>>(() => new Set())
  const [sort, setSort] = useState<SortState>({ key: "opened_at", dir: "asc" })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Kept alongside the grid's row store -- the analytics panel reads the raw entries, the grid reads
  // the store's rows, and the two are populated and pruned together below.
  const [entries, setEntries] = useState<JournalEntry[]>([])
  // The row last clicked: its entry/exit notes show under the analytics panel's P&L curve.
  const [focusedId, setFocusedId] = useState<RowId | null>(null)
  const focusedEntry = focusedId === null ? null : (entries.find((e) => String(e.id) === String(focusedId)) ?? null)

  useEffect(() => {
    if (!token || !active) return
    const request = memberId !== undefined ? getMemberJournal(token, memberId, mode) : getJournal(token, scope, mode)
    request
      .then((entries: JournalEntry[]) => {
        // Replace rather than merge: a manager's view can lose rows (a member deleted an entry).
        const fresh = new Set(entries.map((e) => String(e.id)))
        const stale = store.getIds().filter((id) => !fresh.has(String(id)))
        store.applyDeltas({ upsert: entries.map(toJournalRow), remove: stale })
        setEntries(entries)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the trade journal."))
  }, [token, active, scope, memberId, mode, store])

  async function deleteSelected() {
    if (!token || selection.size === 0) return
    setDeleting(true)
    setError(null)
    const ids = [...selection]
    try {
      await deleteJournalEntries(token, ids.map(Number), mode)
      store.applyDeltas({ remove: ids })
      const removed = new Set(ids.map(String))
      setEntries((prev) => prev.filter((e) => !removed.has(String(e.id))))
      setSelection(new Set())
      setConfirmOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the selected trades.")
      setConfirmOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {selection.size > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{selection.size} selected</span>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger render={<Button type="button" variant="destructive" size="sm" />}>Delete selected</AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Delete {selection.size} journal {selection.size === 1 ? "entry" : "entries"}?
                </AlertDialogTitle>
                <AlertDialogDescription>This removes the record from the trade journal for good. It doesn't reopen the position.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" disabled={deleting} onClick={deleteSelected}>
                  {deleting ? "Deleting…" : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex min-h-0 w-full flex-1 items-start gap-2">
        {/* w-fit: the grid's columns are fixed-width, so it only needs its own content width --
            the analytics panel (flex-1) takes whatever space that leaves, instead of the grid
            stretching to fill the row and leaving the panel squeezed against the edge. */}
        <div className="min-h-0 h-full w-fit max-w-full shrink-0 rounded-md border border-border p-1">
          <AuditTrail
            store={store}
            label={label}
            columns={columns}
            time={formatDateTime}
            value={formatChangeValue}
            selectionColumn={memberId === undefined}
            selection={selection}
            onSelectionChange={setSelection}
            sort={sort}
            onSortChange={setSort}
            focusedRowId={focusedId}
            onFocusedRowChange={setFocusedId}
            onExport={(csv) => downloadCsv(csv, `${memberId !== undefined ? "member" : scope}-${mode === "paper" ? "paper-" : ""}trade-journal.csv`)}
            pane={false}
          />
        </div>
        <JournalAnalyticsPanel journal={entries} selected={focusedEntry} />
      </div>
    </div>
  )
}
