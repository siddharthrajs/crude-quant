import type { InstrumentHit, InstrumentSearchFn } from "@/components/ui/instrument-search"
import type { InstrumentRecord } from "@/lib/api"

export const symbolOf = (record: InstrumentRecord): string => `${record.product} ${record.tenor} ${record.instrument_type}`

/** Turns the instrument catalogue into the synchronous, in-memory search `InstrumentSearch` and the
 * command palette both want: no network round trip, the whole live list already sits in memory. */
export function makeInstrumentSearch(instruments: InstrumentRecord[]): InstrumentSearchFn {
  return async (query) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const hits: InstrumentHit[] = []
    for (const record of instruments) {
      const haystack = `${record.product} ${record.product_label} ${record.tenor} ${record.label} ${record.instrument_type}`.toLowerCase()
      if (!words.every((word) => haystack.includes(word))) continue
      hits.push({
        id: record.item,
        // Unique across products (plain "V26 OUTRIGHT" collides between Brent and WTI), since the
        // command palette's symbol adapter only round-trips this string, not the hit's id.
        symbol: symbolOf(record),
        name: `${record.product_label} ${record.label} ${record.instrument_type}`,
        kind: record.instrument_type,
        exchange: record.product_label,
      })
      if (hits.length >= 30) break
    }
    return hits
  }
}

/** The instrument a hit came from, for the strategy builder to build a leg from. */
export function instrumentOf(hit: InstrumentHit, instruments: InstrumentRecord[]): InstrumentRecord | undefined {
  return instruments.find((record) => record.item === hit.id)
}

/** The instrument behind a command palette symbol pick, which only round-trips `symbol` (see `symbolOf`). */
export function instrumentBySymbol(symbol: string, instruments: InstrumentRecord[]): InstrumentRecord | undefined {
  return instruments.find((record) => symbolOf(record) === symbol)
}
