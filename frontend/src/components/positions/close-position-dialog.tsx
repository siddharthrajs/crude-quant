import { useState } from "react"
import { useLivePrice } from "@/components/positions/use-live-price"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/hooks/use-auth"
import { formatPrice } from "@/lib/format"
import { closePosition, type BookMode, type Position } from "@/lib/positions-api"
import type { RowStore } from "@/lib/row-store"
import type { Tick } from "@/lib/ticks"

export interface ClosePositionDialogProps {
  position: Position | null
  tickStore: RowStore<Tick>
  onOpenChange: (open: boolean) => void
  onClosed: (position: Position) => void
  mode?: BookMode
}

/** Exit a personal-book position, in full or in part: type an exit price (or pull in the live one)
 * and an exit size up to the position's full size. Closing here also closes (or partially exits) the
 * linked team copy (if shared) and writes both books' trade journal -- server-side, see
 * `POST /api/positions/{id}/close`. */
export function ClosePositionDialog({ position, tickStore, onOpenChange, onClosed, mode }: ClosePositionDialogProps) {
  return (
    <Dialog open={position !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {position && (
          // Keyed by position id so switching to a different position starts the form's local state
          // fresh via remount, instead of resetting it with a setState-in-effect.
          <ClosePositionForm key={position.id} position={position} tickStore={tickStore} onOpenChange={onOpenChange} onClosed={onClosed} mode={mode} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ClosePositionForm({ position, tickStore, onOpenChange, onClosed, mode = "live" }: { position: Position } & Omit<ClosePositionDialogProps, "position">) {
  const { token } = useAuth()
  const [exitPrice, setExitPrice] = useState("")
  const [exitSize, setExitSize] = useState(String(position.size))
  const [exitNote, setExitNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const livePrice = useLivePrice(position.legs, tickStore)

  const exitPriceValue = Number(exitPrice)
  const exitSizeValue = Number(exitSize)
  const isPartial = exitSizeValue > 0 && exitSizeValue < position.size
  const canSubmit =
    exitPrice.trim() !== "" &&
    Number.isFinite(exitPriceValue) &&
    Number.isInteger(exitSizeValue) &&
    exitSizeValue > 0 &&
    exitSizeValue <= position.size &&
    !submitting

  async function submit() {
    if (!token || !canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const closed = await closePosition(token, position.id, exitPriceValue, exitSizeValue, mode, exitNote.trim() === "" ? null : exitNote.trim())
      onClosed(closed)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close the position.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Close position</DialogTitle>
        <DialogDescription>
          {position.strategy_label} — {position.side} {position.size} lot{position.size === 1 ? "" : "s"} @ {position.average_price}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="close-position-size">Exit size (lots)</Label>
          <div className="flex gap-2">
            <Input
              id="close-position-size"
              type="number"
              min={1}
              max={position.size}
              step={1}
              value={exitSize}
              onChange={(e) => setExitSize(e.target.value)}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setExitSize(String(position.size))}>
              Max
            </Button>
          </div>
          {isPartial && <p className="text-xs text-muted-foreground">Partial exit — {position.size - exitSizeValue} lot{position.size - exitSizeValue === 1 ? "" : "s"} stay open.</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="close-position-exit">Exit price</Label>
          <div className="flex gap-2">
            <Input id="close-position-exit" type="number" step={0.01} value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} />
            <Button type="button" variant="outline" size="sm" disabled={livePrice === null} onClick={() => setExitPrice(livePrice === null ? "" : livePrice.toFixed(2))}>
              Use live price
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="close-position-note">Exit note</Label>
          <Textarea
            id="close-position-note"
            rows={3}
            maxLength={2000}
            placeholder="Why are you exiting? (optional)"
            value={exitNote}
            onChange={(e) => setExitNote(e.target.value)}
          />
        </div>

        {error &&<p className="text-xs text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <div className="mr-auto flex items-baseline gap-1.5 text-xs">
          <span className="text-muted-foreground">Live price</span>
          <span className="font-semibold text-primary tabular-nums">{livePrice === null ? "—" : formatPrice(livePrice, { kind: "decimal", decimals: 2 })}</span>
        </div>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" disabled={!canSubmit} onClick={submit}>
          {submitting ? "Closing…" : isPartial ? "Exit partial" : "Close position"}
        </Button>
      </DialogFooter>
    </>
  )
}
