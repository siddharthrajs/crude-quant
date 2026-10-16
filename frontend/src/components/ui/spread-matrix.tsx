import { cn } from "cn"
import { createContext, memo, useContext, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ComponentProps, type ReactNode, type RefObject } from "react"
import { useFlash } from "@/hooks/use-flash"
import { useRow } from "@/hooks/use-row-store"
import { NULL_TOKEN, NUMERIC_CLASS, formatBps, formatTicks, ticksBetween, type InstrumentConvention, type Nullable } from "@/lib/format"
import type { RowId, RowStore } from "@/lib/row-store"

// Callers own the table and its collection markup. Rows read their own quote and cells read the
// column's quote, so a feed update wakes only the pairs it changes. Structures share their leg
// subscriptions across readings; each value cell owns its flash.

/** What a spread is measured in: ticks of price, or basis points of yield. */
export type SpreadBasis = "ticks" | "bps"

/** One axis entry of the matrix. */
export interface SpreadInstrument {
  /** The quote's row id in the store. */
  id: RowId
  /** The header text. */
  label: string
  /** The tick a spread in ticks is counted in when this instrument is the row. */
  convention: InstrumentConvention
}

/**
 * A quote as the default reader expects it: `price` for a spread in ticks, `yield` in percent for one in basis
 * points. Pass `value` to read other fields.
 */
export interface SpreadQuote {
  price?: number | null
  yield?: number | null
}

/** A curve or a butterfly: two or three legs, each an instrument's id, with a weight per leg. */
export interface SpreadStructure {
  id: string
  label: string
  legs: readonly [RowId, RowId] | readonly [RowId, RowId, RowId]
  /** One weight per leg. Default `[-1, 1]` for two legs (the second less the first) and `[-1, 2, -1]` for three (the belly against the wings). */
  weights?: readonly number[]
  /** The tick a spread in ticks is counted in. Default: the first leg's instrument. */
  tick?: number
}

export interface SpreadMatrixProps<T extends object = SpreadQuote> extends Omit<ComponentProps<"div">, "children"> {
  store: RowStore<T>
  /** Instrument metadata for structure leg labels and fallback ticks. Last duplicate id wins. */
  instruments: readonly SpreadInstrument[]
  children: ReactNode
  /** Default ticks. Yield values are in percent when basis is bps. */
  basis?: SpreadBasis
  /** Read price for ticks or yield for bps by default. Keep stable between renders. */
  value?: (quote: T, basis: SpreadBasis) => Nullable
  /** Format non-null, non-diagonal spreads. Default formatSpread. Keep stable between renders. */
  format?: (value: number, basis: SpreadBasis) => ReactNode
  /** Default 900ms. */
  flashWindowMs?: number
}

const FILL_CLASSES = "data-[direction=up]:bg-up-soft data-[direction=down]:bg-down-soft data-[direction=flat]:bg-flat-soft"
const CELL = "h-7 px-2 text-right whitespace-nowrap"
const HEAD = "h-7 px-2 font-normal text-muted-foreground whitespace-nowrap"

function isNumber(v: Nullable): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/** The default weights of a structure: the second leg less the first, or the belly against the wings. Empty for any other count. */
export function defaultWeights(legs: number): readonly number[] {
  return legs === 2 ? [-1, 1] : legs === 3 ? [-1, 2, -1] : []
}

/** A difference of values in the basis: ticks of `tick`, to the nearest eighth, or basis points from yields in percent, to a thousandth. */
function toBasis(diff: number, basis: SpreadBasis, tick: number): number | null {
  if (basis === "ticks") {
    const ticks = ticksBetween(diff, 0, tick)
    return Number.isNaN(ticks) ? null : ticks
  }
  return Math.round(diff * 100 * 1000) / 1000
}

/** The spread of `a` over `b`: `a − b` in ticks of `tick` or in basis points. Null when a side is missing. */
export function spreadBetween(a: Nullable, b: Nullable, basis: SpreadBasis, tick: number): number | null {
  if (!isNumber(a) || !isNumber(b)) return null
  return toBasis(a - b, basis, tick)
}

/** A structure's spread: each leg's value times its weight, summed, in the basis. Null when a leg is missing or the weights do not match the legs. */
export function structureSpread(values: readonly Nullable[], weights: readonly number[] | undefined, basis: SpreadBasis, tick: number): number | null {
  const w = weights ?? defaultWeights(values.length)
  if (w.length !== values.length || values.length === 0) return null
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!isNumber(v)) return null
    sum += w[i]! * v
  }
  return toBasis(sum, basis, tick)
}

/** A spread with its sign: `+1.5`, `−0.5`, `0` in ticks; `+12.3`, `−0.8` in basis points. The unit is in the header, not the cell. */
export function formatSpread(value: Nullable, basis: SpreadBasis): string {
  return basis === "ticks" ? formatTicks(value) : formatBps(value, { signed: true, unit: "" })
}

/** The default reader: `price` for a spread in ticks, `yield` for one in basis points. */
function defaultValue(quote: object, basis: SpreadBasis): Nullable {
  if (basis === "bps") return "yield" in quote && typeof quote.yield === "number" ? quote.yield : null
  return "price" in quote && typeof quote.price === "number" ? quote.price : null
}

interface Configuration {
  store: RowStore<object>
  instruments: ReadonlyMap<RowId, SpreadInstrument>
  basis: SpreadBasis
  read: (quote: object, basis: SpreadBasis) => Nullable
  format: (value: number, basis: SpreadBasis) => ReactNode
  flashWindowMs: number
}

const MatrixContext = createContext<Configuration | null>(null)

function useConfiguration() {
  const config = useContext(MatrixContext)
  if (!config) throw new Error("SpreadMatrix parts must be inside SpreadMatrix.")
  return config
}

export function SpreadMatrix<T extends object = SpreadQuote>({ store, instruments, basis = "ticks", value, format = formatSpread, flashWindowMs = 900, children, className, ...props }: SpreadMatrixProps<T>) {
  // The reader and store are erased together at the context boundary; only the matching reader sees a quote.
  const config = useMemo<Configuration>(() => ({ store: store as RowStore<object>, instruments: new Map(instruments.map((instrument) => [instrument.id, instrument])), basis, read: (value ?? defaultValue) as Configuration["read"], format, flashWindowMs }), [store, instruments, basis, value, format, flashWindowMs])
  return <MatrixContext value={config}><div {...props} data-slot="tradecn-spread-matrix" data-basis={basis} className={cn("overflow-auto rounded-md border border-border bg-background text-xs text-foreground lining-nums tabular-nums", className)}>{children}</div></MatrixContext>
}

export interface SpreadMatrixTableProps extends ComponentProps<"table"> {
  "aria-label"?: never
  "aria-labelledby"?: never
  label: string
  children: ReactNode
}

/** A native table. Supply a caption describing the spread rule and unit. */
export function SpreadMatrixTable({ label, className, ...props }: SpreadMatrixTableProps) {
  return <table {...props} aria-label={label} aria-labelledby={undefined} className={cn("w-full border-collapse", className)} />
}

/** A column header by default. Use scope="row" for row labels. */
export function SpreadMatrixHead({ scope = "col", className, ...props }: ComponentProps<"th">) {
  return <th scope={scope} className={cn(HEAD, scope === "row" && "text-left text-foreground", className)} {...props} />
}

export interface SpreadMatrixRowState {
  instrument: SpreadInstrument
  value: number | null
}
const RowContext = createContext<SpreadMatrixRowState | null>(null)

/** Read the current row without adding a subscription. */
export function useSpreadMatrixRow(): SpreadMatrixRowState {
  const row = useContext(RowContext)
  if (!row) throw new Error("useSpreadMatrixRow must be inside SpreadMatrixRow.")
  return row
}

export interface SpreadMatrixRowProps extends ComponentProps<"tr"> {
  instrument: SpreadInstrument
  children: ReactNode
}

export const SpreadMatrixRow = memo(function SpreadMatrixRow({ instrument, children, className, ...props }: SpreadMatrixRowProps) {
  const config = useConfiguration()
  const quote = useRow(config.store, instrument.id)
  const raw = quote === undefined ? null : config.read(quote, config.basis)
  const value = isNumber(raw) ? raw : null
  const row = useMemo(() => ({ instrument, value }), [instrument, value])
  return <RowContext value={row}><tr {...props} data-row={instrument.id} className={cn("border-t border-border/60", className)}>{children}</tr></RowContext>
})

export interface SpreadMatrixCellState {
  spread: number | null
  basis: SpreadBasis
  diagonal: boolean
}
const CellContext = createContext<SpreadMatrixCellState | null>(null)

/** Read a matrix or structure cell without adding subscriptions or flashes. */
export function useSpreadMatrixCell(): SpreadMatrixCellState {
  const cell = useContext(CellContext)
  if (!cell) throw new Error("useSpreadMatrixCell must be inside SpreadMatrixCell or SpreadMatrixStructureCell.")
  return cell
}

/** The signed reading, blank on the diagonal and an en dash when missing. */
export function SpreadMatrixValue({ className, ...props }: Omit<ComponentProps<"span">, "children">) {
  const config = useConfiguration()
  const { spread, basis, diagonal } = useSpreadMatrixCell()
  return <span {...props} data-numeric="" className={cn(NUMERIC_CLASS, className)}>{diagonal ? null : spread === null ? NULL_TOKEN : config.format(spread, basis)}</span>
}

// This effect follows the td so its ref is attached before the first layout effect. Only the flash
// owner remounts on a new instrument pair; the native cell, caller content and focus stay in place.
function CellFlash({ target, spread, diagonal }: { target: RefObject<HTMLTableCellElement | null>; spread: number | null; diagonal: boolean }) {
  const { flashWindowMs } = useConfiguration()
  useFlash(target, spread, { windowMs: flashWindowMs, variant: "fill", disabled: diagonal })
  useLayoutEffect(() => {
    const cell = target.current
    return () => { if (cell) delete cell.dataset.direction }
  }, [target])
  return null
}

function ValueCell({ identity, spread, diagonal = false, ref, className, children, ...props }: ComponentProps<"td"> & { identity: string; spread: number | null; diagonal?: boolean }) {
  const config = useConfiguration()
  const local = useRef<HTMLTableCellElement>(null)
  useImperativeHandle(ref, () => local.current!, [])
  const state = useMemo(() => ({ spread, basis: config.basis, diagonal }), [spread, config.basis, diagonal])
  return <CellContext value={state}>
    <td {...props} ref={local} data-numeric="" data-diagonal={diagonal ? "" : undefined} className={cn(CELL, NUMERIC_CLASS, FILL_CLASSES, diagonal && "bg-muted/40", className)}>{children === undefined ? <SpreadMatrixValue /> : children}</td>
    <CellFlash key={identity} target={local} spread={spread} diagonal={diagonal} />
  </CellContext>
}

export interface SpreadMatrixCellProps extends ComponentProps<"td"> {
  column: RowId
}

export const SpreadMatrixCell = memo(function SpreadMatrixCell({ column, ...props }: SpreadMatrixCellProps) {
  const config = useConfiguration()
  const row = useSpreadMatrixRow()
  const quote = useRow(config.store, column)
  const diagonal = row.instrument.id === column
  const spread = diagonal ? null : spreadBetween(row.value, quote === undefined ? null : config.read(quote, config.basis), config.basis, row.instrument.convention.tick)
  return <ValueCell {...props} data-row={row.instrument.id} data-column={column} identity={JSON.stringify([row.instrument.id, column])} spread={spread} diagonal={diagonal} />
})

export interface SpreadMatrixStructureState {
  structure: SpreadStructure
  legLabels: readonly string[]
  weights: readonly number[]
  spread: number | null
  basis: SpreadBasis
}
const StructureContext = createContext<SpreadMatrixStructureState | null>(null)

/** Read a structure and its legs without subscribing again. */
export function useSpreadMatrixStructure(): SpreadMatrixStructureState {
  const structure = useContext(StructureContext)
  if (!structure) throw new Error("useSpreadMatrixStructure must be inside SpreadMatrixStructureRow.")
  return structure
}

export interface SpreadMatrixStructureRowProps extends ComponentProps<"tr"> {
  structure: SpreadStructure
  children: ReactNode
}

export const SpreadMatrixStructureRow = memo(function SpreadMatrixStructureRow({ structure, children, className, ...props }: SpreadMatrixStructureRowProps) {
  const config = useConfiguration()
  const [a, b, c] = structure.legs
  // Keep the hook count fixed when a curve becomes a butterfly; a curve reads its second leg twice.
  const qa = useRow(config.store, a)
  const qb = useRow(config.store, b)
  const qc = useRow(config.store, c ?? b)
  const values = (c === undefined ? [qa, qb] : [qa, qb, qc]).map((quote) => quote === undefined ? null : config.read(quote, config.basis))
  const tick = structure.tick ?? config.instruments.get(a)?.convention.tick ?? NaN
  const weights = structure.weights ?? defaultWeights(structure.legs.length)
  const spread = structureSpread(values, weights, config.basis, tick)
  const legLabels = structure.legs.map((id) => config.instruments.get(id)?.label ?? id)
  const state = { structure, legLabels, weights, spread, basis: config.basis }
  return <StructureContext value={state}><tr {...props} data-structure={structure.id} data-weights={weights.join(" ")} className={cn("border-t border-border/60", className)}>{children}</tr></StructureContext>
})

/** Optional legs column. For another placement, read legLabels with useSpreadMatrixStructure. */
export function SpreadMatrixLegs({ children, className, ...props }: ComponentProps<"td">) {
  const { legLabels } = useSpreadMatrixStructure()
  return <td {...props} data-legs="" className={cn(HEAD, "text-left", className)}>{children === undefined ? legLabels.join(" / ") : children}</td>
}

export function SpreadMatrixStructureCell(props: ComponentProps<"td">) {
  const { structure, spread } = useSpreadMatrixStructure()
  return <ValueCell {...props} data-spread="" identity={structure.id} spread={spread} />
}
