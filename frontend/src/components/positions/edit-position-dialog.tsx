import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/hooks/use-auth"
import { editPosition, getPositionFills, type BookMode, type Position } from "@/lib/positions-api"

export interface EditPositionDialogProps {
  position: Position | null
  onOpenChange: (open: boolean) => void
  onSaved: (position: Position) => void
  mode?: BookMode
}

interface DraftFill {
  key: string
  id: number | null
  size: string
  price: string
  createdAt: string | null
}

/** Edit a personal-book position through the individual entries (partial fills) that make up its
 * size and average price. Saving re-derives the position's size and size-weighted average from the
 * entries -- server-side, see `PUT /api/positions/{id}`. */
export function EditPositionDialog({ position, onOpenChange, onSaved, mode }: EditPositionDialogProps) {
  return (
    <Dialog open={position !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {position && <EditPositionForm key={position.id} position={position} onOpenChange={onOpenChange} onSaved={onSaved} mode={mode} />}
      </DialogContent>
    </Dialog>
  )
}

function EditPositionForm({ position, onOpenChange, onSaved, mode = "live" }: { position: Position } & Omit<EditPositionDialogProps, "position">) {
  const { token } = useAuth()
  const [fills, setFills] = useState<DraftFill[] | null>(null)
  const [stopLoss, setStopLoss] = useState(position.stop_loss === null ? "" : String(position.stop_loss))
  const [takeProfit, setTakeProfit] = useState(position.take_profit === null ? "" : String(position.take_profit))
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    getPositionFills(token, position.id, mode)
      .then((rows) => {
        if (cancelled) return
        setFills(rows.map((f) => ({ key: `f${f.id}`, id: f.id, size: String(f.size), price: String(f.price), createdAt: f.created_at })))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the position's entries.")
      })
    return () => {
      cancelled = true
    }
  }, [token, position.id, mode])

  const parsed = useMemo(
    () =>
      (fills ?? []).map((f) => {
        const size = Number(f.size)
        const price = Number(f.price)
        return { size, price, valid: f.size.trim() !== "" && f.price.trim() !== "" && Number.isInteger(size) && size > 0 && Number.isFinite(price) }
      }),
    [fills],
  )
  const allValid = parsed.length > 0 && parsed.every((f) => f.valid)
  const totalSize = parsed.reduce((sum, f) => sum + (f.valid ? f.size : 0), 0)
  const average = allValid && totalSize > 0 ? parsed.reduce((sum, f) => sum + f.size * f.price, 0) / totalSize : null
  const optionalValid = (v: string) => v.trim() === "" || Number.isFinite(Number(v))
  const canSubmit = allValid && optionalValid(stopLoss) && optionalValid(takeProfit) && !submitting

  function update(key: string, patch: Partial<DraftFill>) {
    setFills((prev) => prev && prev.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  }

  function addFill() {
    setFills((prev) => [...(prev ?? []), { key: `n${Date.now()}`, id: null, size: "", price: "", createdAt: null }])
  }

  async function submit() {
    if (!token || !fills || !canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const saved = await editPosition(
        token,
        position.id,
        {
          fills: fills.map((f) => ({ id: f.id, size: Number(f.size), price: Number(f.price) })),
          stop_loss: stopLoss.trim() === "" ? null : Number(stopLoss),
          take_profit: takeProfit.trim() === "" ? null : Number(takeProfit),
        },
        mode,
      )
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the position.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit position</DialogTitle>
        <DialogDescription>
          {position.strategy_label} — {position.side}. Each row is an entry netted into the average price.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          <div className="grid grid-cols-[1fr_5rem_6rem_2rem] gap-2 text-[11px] text-muted-foreground">
            <span>Entered</span>
            <span>Lots</span>
            <span>Price</span>
            <span />
          </div>
          {fills === null && !error && <p className="text-xs text-muted-foreground">Loading entries…</p>}
          {fills?.map((f) => (
            <div key={f.key} className="grid grid-cols-[1fr_5rem_6rem_2rem] items-center gap-2">
              <span className="truncate text-xs text-muted-foreground tabular-nums">{f.createdAt ? new Date(f.createdAt).toLocaleString() : "New"}</span>
              <Input aria-label="Lots" type="number" min={1} step={1} value={f.size} onChange={(e) => update(f.key, { size: e.target.value })} />
              <Input aria-label="Price" type="number" step={0.01} value={f.price} onChange={(e) => update(f.key, { price: e.target.value })} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove entry"
                disabled={fills.length <= 1}
                onClick={() => setFills((prev) => prev && prev.filter((x) => x.key !== f.key))}
              >
                ✕
              </Button>
            </div>
          ))}
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" disabled={fills === null} onClick={addFill}>
            Add entry
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-position-sl">Stop loss</Label>
            <Input id="edit-position-sl" type="number" step={0.01} value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-position-tp">Take profit</Label>
            <Input id="edit-position-tp" type="number" step={0.01} value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} />
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <div className="mr-auto flex items-baseline gap-3 text-xs">
          <span>
            <span className="text-muted-foreground">Total </span>
            <span className="font-semibold tabular-nums">{allValid ? `${totalSize} lot${totalSize === 1 ? "" : "s"}` : "—"}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Average </span>
            <span className="font-semibold text-primary tabular-nums">{average === null ? "—" : average.toFixed(4)}</span>
          </span>
        </div>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" disabled={!canSubmit} onClick={submit}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  )
}
