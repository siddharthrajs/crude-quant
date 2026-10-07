import { cn } from "cn"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { QUERY_KIND_LABELS, recognizeQuery, type QueryHint, type QueryKind } from "@/lib/instrument-query"

// A typed field over the consumer's instrument search: it recognizes what was typed (a CUSIP with its
// check digit, an ISIN with its Luhn digit, a ticker, a coupon-and-maturity phrase) and hands the
// server the query with that hint, then lists what came back on the consumer's own `command`.
// Keyboard first: type, arrows, Enter. It knows no instruments; the server does.

export interface InstrumentHit {
  id: string
  /** The name the desk types: a ticker, a run's short form. */
  symbol: string
  /** The long name, "T 4 1/8 05/15/34", "Apple Inc." */
  name?: string
  /** Asset class or instrument type, drawn as a badge. */
  kind?: string
  exchange?: string
  cusip?: string
  isin?: string
}

/** The consumer's search: the query as typed, what it looks like, and a signal that aborts when the query moves on. */
export type InstrumentSearchFn = (query: string, hint: QueryHint, signal: AbortSignal) => Promise<readonly InstrumentHit[]>

export interface InstrumentSearchLabels {
  placeholder: string
  /** While a search is out. */
  searching: string
  /** A search that came back with nothing. `{query}`. */
  empty: string
  /** The list's heading. */
  results: string
  /** Under the field, what the query was taken for. `{kind}`. */
  recognized: string
}

export const DEFAULT_INSTRUMENT_SEARCH_LABELS: InstrumentSearchLabels = {
  placeholder: "Ticker, CUSIP, ISIN, or coupon and maturity",
  searching: "Searching…",
  empty: "Nothing matches {query}.",
  results: "Instruments",
  recognized: "Read as {kind}",
}

const NO_HITS: readonly InstrumentHit[] = []
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "")

/** The debounced, abortable search: only answers to the query on screen come back. */
export function useInstrumentSearch(search: InstrumentSearchFn | undefined, query: string, options: { minLength?: number; debounceMs?: number } = {}) {
  const minLength = options.minLength ?? 1
  const debounceMs = options.debounceMs ?? 150
  const hint = useMemo(() => recognizeQuery(query), [query])
  const [found, setFound] = useState<{ query: string; hits: readonly InstrumentHit[] }>({ query: "", hits: NO_HITS })
  const active = search !== undefined && hint.kind !== "empty" && query.trim().length >= minLength
  useEffect(() => {
    if (!search || !active) return
    const controller = new AbortController()
    const settle = (hits: readonly InstrumentHit[]) => {
      if (!controller.signal.aborted) setFound({ query, hits })
    }
    const timer = setTimeout(() => {
      search(query, hint, controller.signal).then(settle, () => settle(NO_HITS))
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [search, active, query, hint, debounceMs])
  // Only answers to the query on screen. Enter on a row left over from three letters ago is how the wrong instrument gets loaded.
  const current = active && found.query === query
  return { hint, hits: current ? found.hits : NO_HITS, loading: active && !current }
}

/** An adapter the command palette's `symbols` takes, over the same search function. */
export function toSymbolAdapter(search: InstrumentSearchFn, options: { minLength?: number; debounceMs?: number } = {}) {
  return {
    search: async (query: string, signal: AbortSignal) => {
      const hits = await search(query, recognizeQuery(query), signal)
      return hits.map((hit) => ({ symbol: hit.symbol, name: hit.name, exchange: hit.exchange, kind: hit.kind }))
    },
    minLength: options.minLength,
    debounceMs: options.debounceMs,
  }
}

export interface InstrumentSearchProps {
  search: InstrumentSearchFn
  onSelect: (hit: InstrumentHit, hint: QueryHint) => void
  /** Controlled query, with `onQueryChange`. */
  query?: string
  onQueryChange?: (query: string) => void
  /** Default 1. */
  minLength?: number
  /** Default 150. */
  debounceMs?: number
  /** Clear the field after a pick. Default true. */
  clearOnSelect?: boolean
  /** Show what the query was read as under the field. Default true. */
  showHint?: boolean
  autoFocus?: boolean
  labels?: Partial<InstrumentSearchLabels>
  /** How a hit's row reads. Default: the symbol, the name, and the kind as a badge. */
  renderHit?: (hit: InstrumentHit, hint: QueryHint) => React.ReactNode
  className?: string
}

/** The identifier on a hit that the query named, for the row to show beside the name. */
export function matchedIdentifier(hit: InstrumentHit, hint: QueryHint): string | null {
  if (hint.kind === "cusip" && hit.cusip) return hit.cusip
  if (hint.kind === "isin" && hit.isin) return hit.isin
  return null
}

export function InstrumentSearch({ search, onSelect, query: queryProp, onQueryChange, minLength, debounceMs, clearOnSelect = true, showHint = true, autoFocus, labels: labelsProp, renderHit, className }: InstrumentSearchProps) {
  const labels = { ...DEFAULT_INSTRUMENT_SEARCH_LABELS, ...labelsProp }
  const [ownQuery, setOwnQuery] = useState("")
  const query = queryProp ?? ownQuery
  const latest = useRef({ onSelect, onQueryChange })
  useEffect(() => {
    latest.current = { onSelect, onQueryChange }
  })
  const setQuery = (next: string) => {
    if (queryProp === undefined) setOwnQuery(next)
    latest.current.onQueryChange?.(next)
  }
  const { hint, hits, loading } = useInstrumentSearch(search, query, { minLength, debounceMs })
  const hintId = useId()
  const kind: QueryKind = hint.kind
  const pick = (hit: InstrumentHit) => {
    latest.current.onSelect(hit, hint)
    if (clearOnSelect) setQuery("")
  }
  const showList = kind !== "empty" && query.trim().length >= (minLength ?? 1)
  return (
    <div data-slot="tradecn-instrument-search" data-query-kind={kind === "empty" ? undefined : kind} className={cn("flex flex-col gap-1 text-xs lining-nums tabular-nums", className)}>
      {/* The consumer's command does the filtering off: the server answered the query, and every answer stays. */}
      <Command shouldFilter={false} className="rounded-md border border-border">
        <CommandInput value={query} onValueChange={setQuery} placeholder={labels.placeholder} autoFocus={autoFocus} aria-describedby={showHint && kind !== "empty" ? hintId : undefined} className="h-8 text-xs" />
        {showList && (
          <CommandList>
            {loading && hits.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">{labels.searching}</div>}
            {!loading && hits.length === 0 && <CommandEmpty>{fill(labels.empty, { query: query.trim() })}</CommandEmpty>}
            {hits.length > 0 && (
              <CommandGroup heading={labels.results}>
                {hits.map((hit) => (
                  <CommandItem key={hit.id} value={hit.id} data-instrument-hit={hit.id} onSelect={() => pick(hit)}>
                    {renderHit ? (
                      renderHit(hit, hint)
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="font-semibold">{hit.symbol}</span>
                        {hit.name && <span className="min-w-0 truncate text-muted-foreground">{hit.name}</span>}
                        {matchedIdentifier(hit, hint) && <span className="font-(family-name:--tradecn-font-mono) text-muted-foreground lining-nums tabular-nums">{matchedIdentifier(hit, hint)}</span>}
                        {hit.kind && (
                          <Badge variant="outline" className="ml-auto h-4 px-1 text-xs">
                            {hit.kind}
                          </Badge>
                        )}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        )}
      </Command>
      {showHint && kind !== "empty" && (
        <p id={hintId} data-instrument-hint={kind} className="px-1 text-muted-foreground">
          {fill(labels.recognized, { kind: QUERY_KIND_LABELS[kind] })}
          {kind === "coupon-maturity" && hint.coupon !== undefined && " "}
          {kind === "coupon-maturity" && hint.coupon !== undefined && (
            <span className="font-(family-name:--tradecn-font-mono) lining-nums tabular-nums">
              {hint.ticker ? `${hint.ticker} ` : ""}
              {hint.coupon} {hint.maturity}
            </span>
          )}
        </p>
      )}
    </div>
  )
}
