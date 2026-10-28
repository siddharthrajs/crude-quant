import { useEffect, useMemo, useRef, useState } from "react"
import { StrategyCombobox, type StrategyOption } from "@/components/positions/strategy-combobox"
import { useLivePrice } from "@/components/positions/use-live-price"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/hooks/use-auth"
import { CURVE_CONVENTION } from "@/lib/curve-series"
import { formatPrice } from "@/lib/format"
import type { InstrumentRecord, StructureRecord } from "@/lib/api"
import { createPosition, type BookMode, type Position, type Side } from "@/lib/positions-api"
import type { RowStore } from "@/lib/row-store"
import { resolveStrategy, strategyLabel, STRATEGY_CODES } from "@/lib/strategy-resolver"
import type { Tick } from "@/lib/ticks"

export interface AddPositionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instruments: InstrumentRecord[]
  customStructures: StructureRecord[]
  tickStore: RowStore<Tick>
  onCreated: (position: Position) => void
  mode?: BookMode
}

function compareSortKey(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const ENTRY_TICK = CURVE_CONVENTION.tick
const ENTRY_DECIMALS = 2
const ENTRY_MAX_DECIMALS = 3

/** One tick up or down from a typed price. The entry price need not sit on the tick grid, so an
 * off-grid price steps by exactly one tick rather than snapping. Printed at two decimals, three when the
 * price needs them. An empty or unparseable field nudges from zero. */
function nudgePrice(current: string, direction: 1 | -1): string {
  const base = Number(current)
  const from = current.trim() !== "" && Number.isFinite(base) ? base : 0
  const next = Number((from + direction * ENTRY_TICK).toFixed(ENTRY_MAX_DECIMALS))
  return next.toFixed(Math.abs(next * 100 - Math.round(next * 100)) < 1e-6 ? ENTRY_DECIMALS : ENTRY_MAX_DECIMALS)
}

/** A price input that steps by one tick on the arrow keys and on the mouse wheel while it has focus. */
function EntryPriceInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const latest = useRef({ value, onChange })
  useEffect(() => {
    latest.current = { value, onChange }
  })

  // Native listener: React's onWheel is passive, so it can't stop the dialog scrolling underneath.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    function onWheel(event: WheelEvent) {
      if (document.activeElement !== el || event.deltaY === 0) return
      event.preventDefault()
      latest.current.onChange(nudgePrice(latest.current.value, event.deltaY < 0 ? 1 : -1))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  return (
    <Input
      ref={ref}
      id={id}
      type="number"
      step={ENTRY_TICK}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
        e.preventDefault()
        onChange(nudgePrice(value, e.key === "ArrowUp" ? 1 : -1))
      }}
    />
  )
}

export function AddPositionDialog({ open, onOpenChange, instruments, customStructures, tickStore, onCreated, mode = "live" }: AddPositionDialogProps) {
  const { token } = useAuth()
  const [product, setProduct] = useState("")
  const [strategy, setStrategy] = useState<StrategyOption | null>(null)
  const [size, setSize] = useState("1")
  const [side, setSide] = useState<Side>("long")
  const [entryPrice, setEntryPrice] = useState("0.00")
  const [stopLoss, setStopLoss] = useState("")
  const [takeProfit, setTakeProfit] = useState("")
  const [shareWithTeam, setShareWithTeam] = useState(false)
  const [entryNote, setEntryNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const products = useMemo(() => {
    const seen = new Map<string, string>()
    for (const i of instruments) if (!seen.has(i.product)) seen.set(i.product, i.product_label)
    return [...seen.entries()]
  }, [instruments])

  const productStructures = useMemo(
    () => customStructures.filter((s) => s.product === product || s.product === null),
    [customStructures, product],
  )

  const tenors = useMemo(() => {
    return instruments
      .filter((i) => i.product === product && i.instrument_type === "OUTRIGHT")
      .sort((a, b) => compareSortKey(a.sort_key, b.sort_key))
      .map((i) => i.tenor)
  }, [instruments, product])

  // Every tenor x strategy-code combination that actually resolves to a live instrument, labeled
  // "X26 1MF", plus the user's own custom structures under their own label. Only what's live is
  // offered -- there's no point letting someone pick a strategy the desk can't currently price.
  const strategyOptions = useMemo<StrategyOption[]>(() => {
    if (!product) return []
    const standard: StrategyOption[] = []
    for (const tenor of tenors) {
      for (const code of STRATEGY_CODES) {
        const legs = resolveStrategy(code, product, tenor, instruments)
        if (legs) standard.push({ key: `${tenor}:${code}`, label: strategyLabel(code, tenor), legs, tenor, code, isCustom: false })
      }
    }
    const custom: StrategyOption[] = productStructures.map((s) => ({ key: s.id, label: s.label, legs: s.legs, tenor: null, code: s.id, isCustom: true }))
    return [...standard, ...custom]
  }, [product, tenors, instruments, productStructures])

  // Derived, not reset via an effect: a strategy picked under a since-changed product just stops
  // being one of `strategyOptions` and reads as unpicked, with no state to keep in sync by hand.
  const effectiveStrategy = strategy && strategyOptions.some((o) => o.key === strategy.key) ? strategy : null

  const livePrice = useLivePrice(effectiveStrategy?.legs ?? null, tickStore)

  function reset() {
    setProduct("")
    setStrategy(null)
    setSize("1")
    setSide("long")
    setEntryPrice("0.00")
    setStopLoss("")
    setTakeProfit("")
    setShareWithTeam(false)
    setEntryNote("")
    setError(null)
  }

  const sizeValue = Number(size)
  const entryPriceValue = Number(entryPrice)
  const canSubmit =
    Boolean(product) &&
    effectiveStrategy !== null &&
    Number.isInteger(sizeValue) &&
    sizeValue > 0 &&
    entryPrice.trim() !== "" &&
    Number.isFinite(entryPriceValue) &&
    !submitting

  async function submit() {
    if (!token || !canSubmit || !effectiveStrategy) return
    setSubmitting(true)
    setError(null)
    try {
      const position = await createPosition(token, {
        product,
        strategy_code: effectiveStrategy.code,
        strategy_label: effectiveStrategy.label,
        tenor: effectiveStrategy.tenor,
        legs: effectiveStrategy.legs,
        size: sizeValue,
        side,
        average_price: entryPriceValue,
        stop_loss: stopLoss.trim() === "" ? null : Number(stopLoss),
        take_profit: takeProfit.trim() === "" ? null : Number(takeProfit),
        share_with_team: shareWithTeam,
        entry_note: entryNote.trim() === "" ? null : entryNote.trim(),
      }, mode)
      onCreated(position)
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the position.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "paper" ? "Add paper position" : "Add position"}</DialogTitle>
          <DialogDescription>Opens in your personal book. Check "Share with team" to also open a linked copy in the team book.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-position-product">Product</Label>
              <Select value={product} onValueChange={(v) => setProduct(v as string)}>
                <SelectTrigger id="add-position-product">
                  <SelectValue>{(v: string) => products.find(([key]) => key === v)?.[1] ?? "Select a product"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {products.map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-position-strategy">Strategy</Label>
              <StrategyCombobox id="add-position-strategy" options={strategyOptions} value={effectiveStrategy} onChange={setStrategy} disabled={!product} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-position-size">Size (lots)</Label>
              <Input id="add-position-size" type="number" min={1} step={1} value={size} onChange={(e) => setSize(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-position-side">Position</Label>
              <Select value={side} onValueChange={(v) => setSide(v as Side)}>
                <SelectTrigger id="add-position-side">
                  <SelectValue>{(v: Side) => (v === "long" ? "Long" : "Short")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="long">Long</SelectItem>
                  <SelectItem value="short">Short</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-position-entry">Entry price</Label>
              <div className="flex gap-1.5">
                <EntryPriceInput id="add-position-entry" value={entryPrice} onChange={setEntryPrice} />
                <Button type="button" variant="outline" size="sm" disabled={livePrice === null} onClick={() => setEntryPrice(livePrice === null ? "" : livePrice.toFixed(2))}>
                  Use live
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-position-stop">Stop loss</Label>
              <Input id="add-position-stop" type="number" step="any" placeholder="Optional" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-position-take">Take profit</Label>
              <Input id="add-position-take" type="number" step="any" placeholder="Optional" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-position-note">Entry note</Label>
            <Textarea
              id="add-position-note"
              rows={3}
              maxLength={2000}
              placeholder="Why are you putting this trade on? (optional)"
              value={entryNote}
              onChange={(e) => setEntryNote(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={shareWithTeam} onCheckedChange={(checked) => setShareWithTeam(checked === true)} />
            Share with team
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
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
            {submitting ? "Adding…" : "Add position"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
