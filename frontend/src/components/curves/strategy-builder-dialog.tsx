import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { InstrumentSearch, type InstrumentHit } from "@/components/ui/instrument-search"
import { createStructure, type InstrumentRecord, type StructureRecord } from "@/lib/api"
import { makeInstrumentSearch } from "@/lib/instrument-search-adapter"

interface LegDraft {
  key: number
  hit: InstrumentHit | null
  weight: number
}

let nextKey = 1
const blankLeg = (weight = 1): LegDraft => ({ key: nextKey++, hit: null, weight })

export interface StrategyBuilderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  instruments: InstrumentRecord[]
  onCreated: (structure: StructureRecord) => void
}

/** Any combination of legs the feed carries -- spreads, flies, or anything else -- built by hand and
 * streamed by the backend's structure engine the moment it's created. */
export function StrategyBuilderDialog({ open, onOpenChange, instruments, onCreated }: StrategyBuilderDialogProps) {
  const [label, setLabel] = useState("")
  const [legs, setLegs] = useState<LegDraft[]>(() => [blankLeg(1), blankLeg(-1)])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const search = useMemo(() => makeInstrumentSearch(instruments), [instruments])

  function reset() {
    setLabel("")
    setLegs([blankLeg(1), blankLeg(-1)])
    setError(null)
  }

  const canSubmit = label.trim().length > 0 && legs.filter((leg) => leg.hit).length >= 1 && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const picked = legs.filter((leg): leg is LegDraft & { hit: InstrumentHit } => leg.hit !== null)
      const structure = await createStructure(
        label.trim(),
        picked.map((leg) => ({ item: leg.hit.id, weight: leg.weight })),
      )
      onCreated(structure)
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the strategy.")
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
          <DialogTitle>New strategy</DialogTitle>
          <DialogDescription>Combine any legs the feed carries -- a spread, a fly, a double fly, or anything else -- into one synthetic price the backend streams live.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="strategy-label">
              Label
            </label>
            <Input id="strategy-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Brent V26/X26/Z26 condor" maxLength={80} />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Legs</span>
            {legs.map((leg, i) => (
              <div key={leg.key} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  {leg.hit ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1">
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {leg.hit.kind}
                      </Badge>
                      <span className="truncate text-xs">{leg.hit.name}</span>
                      <button
                        type="button"
                        className="ml-auto shrink-0 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setLegs((prev) => prev.map((l) => (l.key === leg.key ? { ...l, hit: null } : l)))}
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <InstrumentSearch
                      search={search}
                      autoFocus={false}
                      onSelect={(hit) => setLegs((prev) => prev.map((l) => (l.key === leg.key ? { ...l, hit } : l)))}
                    />
                  )}
                </div>
                <Input
                  type="number"
                  step="any"
                  value={leg.weight}
                  onChange={(e) => setLegs((prev) => prev.map((l) => (l.key === leg.key ? { ...l, weight: Number(e.target.value) } : l)))}
                  className="w-20"
                  aria-label={`Weight for leg ${i + 1}`}
                />
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove leg" disabled={legs.length <= 1} onClick={() => setLegs((prev) => prev.filter((l) => l.key !== leg.key))}>
                  ×
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setLegs((prev) => [...prev, blankLeg(1)])}>
              Add leg
            </Button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {submitting ? "Creating…" : "Create strategy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
