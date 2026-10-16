export const NULL_TOKEN = "–"
const MINUS = "−"

export type Nullable = number | null | undefined

export interface Locale {
  /** BCP 47 tag; defaults to en-US. */
  locale?: string
}

export type PriceConvention =
  /** Fixed decimals, e.g. equities at 2. */
  | { kind: "decimal"; decimals: number }
  /** Decimals derived from the instrument's tick size, e.g. 0.001 gives 3. */
  | { kind: "tick"; tick: number }
  /**
   * Fractional quoting. `denominator` 32 or 64; `half` renders a half tick as "+" (99-16+) or "5" (99-165);
   * `eighths` renders eighths of a tick as a trailing digit (99-162 is 99 and 16 2/8 thirty-seconds).
   */
  | { kind: "fraction"; denominator: 32 | 64; half: "+" | "5"; eighths?: boolean }

/** What a quote is typed and read in. Bills quote on discount, most bonds on price, some on yield, credit often on a spread in basis points. */
export type QuoteBasis = "price" | "yield" | "discount" | "spread"

export interface InstrumentConvention {
  price: PriceConvention
  /** Smallest price increment, used for stepping and rounding. */
  tick: number
  yieldDecimals?: number
  quantityUnit?: "notional" | "contracts"
  /** Default price. */
  quoteBasis?: QuoteBasis
  /** What a quote steps by in its basis. Default: the tick for price, 0.001 for yield and discount, 0.1 for spread. */
  quoteStep?: number
  /** Decimals for a yield, discount, or spread quote. Default 3, 3, and 1. Price quotes follow their convention. */
  quoteDecimals?: number
}

function isNil(v: Nullable): v is null | undefined {
  return v === null || v === undefined || !Number.isFinite(v)
}

// One Intl.NumberFormat per locale and option set; construction is the expensive part.
const formatters = new Map<string, Intl.NumberFormat>()

/** True for a time a `Date` can hold: a finite number of milliseconds within 8.64e15 of the epoch either way. */
export const isInstant = (ms: unknown): ms is number => Number.isFinite(ms) && Math.abs(ms as number) <= 8.64e15

export function numberFormat(locale: string | undefined, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? "en-US"}|${JSON.stringify(options)}`
  let nf = formatters.get(key)
  if (!nf) {
    nf = new Intl.NumberFormat(locale ?? "en-US", options)
    formatters.set(key, nf)
  }
  return nf
}

function fixed(v: number, decimals: number, locale?: string, extra: Intl.NumberFormatOptions = {}): string {
  return numberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, ...extra }).format(v)
}

function typographicMinus(s: string): string {
  return s.replace(/-/g, MINUS)
}

/** Decimal places needed to show a price on this tick grid. 0.001 gives 3, 1/32 gives 5, 1 gives 0. Capped at `max`. */
export function decimalsFromTick(tick: number, max = 8): number {
  if (!Number.isFinite(tick) || tick <= 0) return 0
  for (let d = 0; d <= max; d++) {
    const scaled = tick * 10 ** d
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return d
  }
  return max
}

/** Nearest price on the tick grid, cleaned of float noise. */
export function roundToTick(v: number, tick: number): number {
  if (!Number.isFinite(v) || !Number.isFinite(tick) || tick <= 0) return v
  return Number((Math.round(v / tick) * tick).toFixed(decimalsFromTick(tick)))
}

/** Move `steps` ticks (negative allowed) from the nearest grid price. */
export function stepByTick(v: number, tick: number, steps: number): number {
  return roundToTick(roundToTick(v, tick) + steps * tick, tick)
}

/** Whole-number and sub-tick decomposition on an integer grid so 32nds never drift. */
function decomposeFraction(v: number, c: Extract<PriceConvention, { kind: "fraction" }>) {
  const sub = c.eighths ? 8 : 2
  const unitsPerWhole = c.denominator * sub
  const total = Math.round(Math.abs(v) * unitsPerWhole)
  const whole = Math.floor(total / unitsPerWhole)
  const rem = total - whole * unitsPerWhole
  const ticks = Math.floor(rem / sub)
  const subticks = rem - ticks * sub
  return { negative: v < 0 && total > 0, whole, ticks, subticks, sub }
}

/** 99.515625 as "99-16+" (32nds, half "+"), "99-165" (half "5"), or "99-164" with eighths. */
export function formatFraction(v: Nullable, c: Extract<PriceConvention, { kind: "fraction" }>): string {
  if (isNil(v)) return NULL_TOKEN
  const { negative, whole, ticks, subticks, sub } = decomposeFraction(v, c)
  let tail = ""
  if (subticks !== 0) {
    if (c.eighths) tail = String(subticks)
    else tail = c.half
  }
  void sub
  return `${negative ? MINUS : ""}${whole}-${String(ticks).padStart(2, "0")}${tail}`
}

export function formatPrice(v: Nullable, c: PriceConvention, l?: Locale): string {
  if (isNil(v)) return NULL_TOKEN
  switch (c.kind) {
    case "decimal":
      return typographicMinus(fixed(v, c.decimals, l?.locale))
    case "tick":
      return typographicMinus(fixed(roundToTick(v, c.tick), decimalsFromTick(c.tick), l?.locale))
    case "fraction":
      return formatFraction(v, c)
  }
}

/**
 * Inverse of formatPrice for ticket entry. Accepts the convention's own notation and a plain decimal.
 * Returns null when the text is not a price. Fraction input: "99-16+", "99-165", "99-162", "99-16", "99".
 */
export function parsePrice(s: string, c: PriceConvention): number | null {
  const text = s.trim().replace(/−/g, "-").replace(/,/g, "")
  if (!text) return null
  if (c.kind === "fraction") {
    const m = /^([+-]?)(\d+)(?:-(\d{1,2})([+0-9])?)?$/.exec(text)
    if (m) {
      const [, sign, wholeText, ticksText, tail] = m
      const ticks = ticksText ? Number(ticksText) : 0
      if (ticks >= c.denominator) return null
      let subFraction = 0
      if (tail === "+") subFraction = 0.5
      else if (tail !== undefined) {
        const digit = Number(tail)
        if (c.eighths) {
          if (digit > 7) return null
          subFraction = digit / 8
        } else if (c.half === "5" && digit === 5) subFraction = 0.5
        else if (digit === 0) subFraction = 0
        else return null
      }
      const value = Number(wholeText) + (ticks + subFraction) / c.denominator
      return sign === "-" ? -value : value
    }
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  if (c.kind === "tick") return roundToTick(n, c.tick)
  if (c.kind === "decimal") return Number(n.toFixed(c.decimals))
  return n
}

/** 4.2531 as "4.253%". */
export function formatYield(v: Nullable, o: { decimals?: number; suffix?: "%" | "" } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  return typographicMinus(fixed(v, o.decimals ?? 3, o.locale)) + (o.suffix ?? "%")
}

/** 12.5 as "12.5 bp"; signed gives "+12.5 bp". */
export function formatBps(v: Nullable, o: { decimals?: number; signed?: boolean; unit?: "bp" | "bps" | "" } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  const unit = o.unit ?? "bp"
  const body = o.signed ? formatSigned(v, { decimals: o.decimals ?? 1, locale: o.locale }) : typographicMinus(fixed(v, o.decimals ?? 1, o.locale))
  return unit ? `${body} ${unit}` : body
}

/** Dollar value of a basis point as whole currency; compact gives "$1.23K". */
export function formatDv01(v: Nullable, o: { currency?: string; compact?: boolean } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  const currency = o.currency ?? "USD"
  if (o.compact) {
    const symbol = numberFormat(o.locale, { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 })
      .formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? ""
    return `${v < 0 ? MINUS : ""}${symbol}${formatNotional(Math.abs(v), { compact: true, locale: o.locale })}`
  }
  return typographicMinus(numberFormat(o.locale, { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(v))
}

/** 1250000 as "1.25M" (compact), "1.25mm" (unit "mm", the desk's word for millions, never scaled further), or "1,250,000.00". Compact suffixes K, M, B, T. */
export function formatNotional(v: Nullable, o: { compact?: boolean; decimals?: number; unit?: "mm" } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  const decimals = o.decimals ?? 2
  if (o.unit === "mm") return typographicMinus(numberFormat(o.locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(v / 1e6)) + "mm"
  if (!o.compact) return typographicMinus(fixed(v, decimals, o.locale))
  const abs = Math.abs(v)
  const [divisor, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""]
  return typographicMinus(fixed(v / divisor, suffix ? decimals : 0, o.locale)) + suffix
}

/** "+0.12", "−0.12" (U+2212), and "0.00" for zero: flat carries no sign. */
export function formatSigned(v: Nullable, o: { decimals?: number } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  return typographicMinus(fixed(v, o.decimals ?? 2, o.locale, { signDisplay: "exceptZero" }))
}

/** `formatSigned`, in dollars: "+$1,234.56", "−$250.00" (U+2212), "$0.00" for zero. */
export function formatSignedUsd(v: Nullable, o: { decimals?: number } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  return typographicMinus(fixed(v, o.decimals ?? 2, o.locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", signDisplay: "exceptZero" }))
}

/** 1.234 as "1.23%"; signed gives "+1.23%". */
export function formatPercent(v: Nullable, o: { decimals?: number; signed?: boolean } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  const decimals = o.decimals ?? 2
  return (o.signed ? formatSigned(v, { decimals, locale: o.locale }) : typographicMinus(fixed(v, decimals, o.locale))) + "%"
}

/** Whole quantities with grouping: 1000000 as "1,000,000". */
export function formatQuantity(v: Nullable, l?: Locale): string {
  if (isNil(v)) return NULL_TOKEN
  return typographicMinus(fixed(Math.round(v), 0, l?.locale))
}

/**
 * A coupon the way a run prints it: 4.125 as "4 1/8", 4.5 as "4 1/2", 4 as "4", 0 as "0" (coupons step in eighths).
 * One off the eighths grid prints as a plain decimal, "4.1". `style: "decimal"` prints "4.125%".
 */
export function formatCoupon(v: Nullable, o: { style?: "fraction" | "decimal"; decimals?: number } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  if (o.style === "decimal") return typographicMinus(fixed(v, o.decimals ?? 3, o.locale)) + "%"
  const eighths = Math.round(Math.abs(v) * 8)
  if (Math.abs(eighths / 8 - Math.abs(v)) > 1e-9) return typographicMinus(numberFormat(o.locale, { minimumFractionDigits: 0, maximumFractionDigits: o.decimals ?? 3 }).format(v))
  const whole = Math.floor(eighths / 8)
  const rem = eighths % 8
  const fraction = rem === 0 ? "" : rem % 4 === 0 ? "1/2" : rem % 2 === 0 ? `${rem / 2}/4` : `${rem}/8`
  const body = fraction ? (whole ? `${whole} ${fraction}` : fraction) : String(whole)
  return `${v < 0 && eighths > 0 ? MINUS : ""}${body}`
}

/** A date as an instant, a millisecond count, or a string `Date` can read. A date-only string ("2034-05-15") is that day in UTC. */
export type DateLike = Date | number | string

function toDate(d: DateLike | null | undefined): Date | null {
  if (d === null || d === undefined) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * A maturity as a run prints it: "05/15/34", or "05/15/2034" with `year: "numeric"`. Read in UTC, so a
 * date-only string prints as that day wherever the screen is.
 */
export function formatMaturity(d: DateLike | null | undefined, o: { year?: "2-digit" | "numeric" } & Locale = {}): string {
  const date = toDate(d)
  if (!date) return NULL_TOKEN
  const key = `${o.locale ?? "en-US"}|${o.year ?? "2-digit"}`
  let f = dateFormatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(o.locale ?? "en-US", { month: "2-digit", day: "2-digit", year: o.year ?? "2-digit", timeZone: "UTC" })
    dateFormatters.set(key, f)
  }
  return f.format(date)
}

/** Whole UTC days from `now` (the moment, by default) to a maturity. Negative once it has passed; null when the date does not read. */
export function daysToMaturity(d: DateLike | null | undefined, now: DateLike = Date.now()): number | null {
  const maturity = toDate(d)
  const from = toDate(now)
  if (!maturity || !from) return null
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
  return Math.round((day(maturity) - day(from)) / 86_400_000)
}

/** How many ticks `a` is from `b`, signed, to the nearest eighth of a tick: 99-17 against 99-16+ on a 1/64 tick is 1. NaN when a side is not a number or the tick is not positive. */
export function ticksBetween(a: number, b: number, tick: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(tick > 0)) return NaN
  return Math.round(((a - b) / tick) * 8) / 8
}

/** A count of ticks: "+1", "−0.5", "0", up to three decimals and no trailing zeros. Signed unless told otherwise; `unit` adds a word. */
export function formatTicks(v: Nullable, o: { signed?: boolean; unit?: string } & Locale = {}): string {
  if (isNil(v)) return NULL_TOKEN
  const body = typographicMinus(numberFormat(o.locale, { minimumFractionDigits: 0, maximumFractionDigits: 3, signDisplay: o.signed === false ? "auto" : "exceptZero" }).format(v))
  return o.unit ? `${body} ${o.unit}` : body
}

/**
 * The class a number wears (contract rule 14): lining, tabular figures whatever the font, in the numeric family.
 * `--tradecn-font-numeric` is the sans by default, so letters stay proportional and only the digits take one
 * width, which is what a column of prices wants. docs/typography.md has the reasoning and the tokens.
 */
export const NUMERIC_CLASS = "font-(family-name:--tradecn-font-numeric) lining-nums tabular-nums"
/** The same figures in the mono stack, `--tradecn-font-mono`: for a fraction quote, whose dash, ticks, and tail must line up down a column. */
export const MONO_NUMERIC_CLASS = "font-(family-name:--tradecn-font-mono) lining-nums tabular-nums"

/**
 * The class for a number printed under a convention: a fraction price (99-16+) sets in the mono stack, so
 * 99-16+ over 99-17 keeps its dash and its tail in the same place; every other price, and every quote in
 * another basis, keeps the numeric family.
 */
export function numericFontClass(c?: PriceConvention | InstrumentConvention | null): string {
  const price = c && "price" in c ? (quoteBasisOf(c) === "price" ? c.price : null) : c
  return price?.kind === "fraction" ? MONO_NUMERIC_CLASS : NUMERIC_CLASS
}

/** The word for a quote field's label, per basis. */
export const QUOTE_BASIS_LABELS: Record<QuoteBasis, string> = { price: "Price", yield: "Yield", discount: "Discount", spread: "Spread" }

const QUOTE_DEFAULTS: Record<Exclude<QuoteBasis, "price">, { step: number; decimals: number }> = {
  yield: { step: 0.001, decimals: 3 },
  discount: { step: 0.001, decimals: 3 },
  spread: { step: 0.1, decimals: 1 },
}

export function quoteBasisOf(c: InstrumentConvention): QuoteBasis {
  return c.quoteBasis ?? "price"
}

/** What a quote steps by in its basis: the tick for a price, else `quoteStep` or the basis default. */
export function quoteStepOf(c: InstrumentConvention): number {
  const basis = quoteBasisOf(c)
  return basis === "price" ? c.tick : (c.quoteStep ?? QUOTE_DEFAULTS[basis].step)
}

function quoteDecimalsOf(c: InstrumentConvention): number {
  const basis = quoteBasisOf(c)
  return basis === "price" ? 0 : (c.quoteDecimals ?? QUOTE_DEFAULTS[basis].decimals)
}

/** A quote in the instrument's basis: a price by its convention, else a fixed decimal with the basis's decimals and no unit, since the field's label says the basis. */
export function formatQuote(v: Nullable, c: InstrumentConvention, l?: Locale): string {
  if (isNil(v)) return NULL_TOKEN
  if (quoteBasisOf(c) === "price") return formatPrice(v, c.price, l)
  return typographicMinus(fixed(roundToTick(v, quoteStepOf(c)), quoteDecimalsOf(c), l?.locale))
}

/** Inverse of formatQuote for a quote field. A price takes its notation or a decimal; the others take a decimal and snap to the quote step. Null when the text is not a quote. */
export function parseQuote(s: string, c: InstrumentConvention): number | null {
  if (quoteBasisOf(c) === "price") return parsePrice(s, c.price)
  const text = s.trim().replace(/−/g, "-").replace(/,/g, "")
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null
  const n = Number(text)
  return Number.isFinite(n) ? roundToTick(n, quoteStepOf(c)) : null
}

/** Move a quote by `steps` of its step, from the nearest grid value. */
export function stepQuote(v: number, c: InstrumentConvention, steps: number): number {
  return stepByTick(v, quoteStepOf(c), steps)
}

/** Bind a convention once per instrument; a grid column calls `formatters[row.instrumentId].price(v)`, a quote field its `quote`, `parseQuote`, and `stepQuote`. */
export function createInstrumentFormatter(c: InstrumentConvention, l?: Locale) {
  return {
    tick: c.tick,
    basis: quoteBasisOf(c),
    quoteStep: quoteStepOf(c),
    price: (v: Nullable) => formatPrice(v, c.price, l),
    yield: (v: Nullable) => formatYield(v, { decimals: c.yieldDecimals ?? 3, locale: l?.locale }),
    step: (v: number, steps: number) => stepByTick(v, c.tick, steps),
    parsePrice: (s: string) => parsePrice(s, c.price),
    quantity: (v: Nullable) => formatQuantity(v, l),
    quote: (v: Nullable) => formatQuote(v, c, l),
    parseQuote: (s: string) => parseQuote(s, c),
    stepQuote: (v: number, steps: number) => stepQuote(v, c, steps),
  }
}
