import { formatQuantity, formatTicks, quoteBasisOf, ticksBetween, type InstrumentConvention } from "@/lib/format"

// Fat-finger checks are universal: a size above a line, a level too far from the market, a side the
// book may not take. The tickets already stop a missing level and a crossed market; this gives them a
// limits table, as data, and returns problems in the shape they already print. A `block` stops the
// action; a `confirm` turns it into a two-step, the blotter's ask-again. Nothing here decides a
// limit: the numbers are the desk's, the words are the consumer's, and the check runs where the
// click lands, against the draft as it is then.

export type ProblemLevel = "block" | "confirm"

export interface Problem {
  /** The field it is about: "quantity", "price", "bid", "ask", or "side". */
  field: string
  level: ProblemLevel
  /** A sentence, in the consumer's words. */
  message: string
  /** Which limit raised it: "maxQuantity", "minQuantity", "maxDistance", "sides", or a custom rule's own name. */
  rule: string
}

/** What the check reads of a draft: a ticket's side, quantity, and price, or a quote's bid and ask. */
export interface LimitsDraft {
  side?: "buy" | "sell"
  quantity?: number | null
  price?: number | null
  bid?: number | null
  ask?: number | null
}

export interface LimitsMarket {
  bid?: number | null
  ask?: number | null
  last?: number | null
  mid?: number | null
}

export interface LimitsLabels {
  /** `{n}` the quantity, `{max}` the limit. */
  quantityAbove: string
  quantityAboveConfirm: string
  /** `{n}` the quantity, `{min}` the limit. */
  quantityBelow: string
  quantityBelowConfirm: string
  /** `{field}` the level's field, `{distance}` how far, `{max}` the limit, both with their unit. */
  tooFar: string
  tooFarConfirm: string
  /** `{side}` the side. */
  sideNotAllowed: string
  buy: string
  sell: string
  ticks: string
  bps: string
}

export const DEFAULT_LIMITS_LABELS: LimitsLabels = {
  quantityAbove: "{n} is above the size limit of {max}.",
  quantityAboveConfirm: "{n} is above {max}. Send it anyway?",
  quantityBelow: "{n} is below the minimum of {min}.",
  quantityBelowConfirm: "{n} is below {min}. Send it anyway?",
  tooFar: "The {field} is {distance} from the market; the limit is {max}.",
  tooFarConfirm: "The {field} is {distance} from the market, past {max}. Send it anyway?",
  sideNotAllowed: "The book does not take a {side}.",
  buy: "buy",
  sell: "sell",
  ticks: "ticks",
  bps: "bp",
}

export interface LimitsContext {
  market?: LimitsMarket
  convention?: InstrumentConvention
  labels?: Partial<LimitsLabels>
}

/** A line, or two: a size to ask again past, and a size to stop at. One number is a stop. */
export type Threshold = number | { confirm?: number; block?: number }

export interface Limits {
  maxQuantity?: Threshold
  minQuantity?: Threshold
  /** How far a level may sit from the market's same side (the mid when there is none), in ticks for a price basis or basis points for the rest. */
  maxDistance?: ({ ticks: number } | { bps: number }) & { level?: ProblemLevel }
  /** The sides the book may take. A ticket's side, or, for a quote, a bid is a buy and an offer a sell. */
  sides?: readonly ("buy" | "sell")[]
  /** Your own rules, in the same shape. */
  custom?: (draft: LimitsDraft, context: LimitsContext) => Problem[]
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""))
}

function thresholds(t: Threshold | undefined): { confirm?: number; block?: number } {
  if (t === undefined) return {}
  return typeof t === "number" ? { block: t } : t
}

/** The market's side a level is measured against: the same side as the level, else the mid, else the last. */
export function marketSideFor(field: "price" | "bid" | "ask", side: "buy" | "sell" | undefined, market: LimitsMarket | undefined): number | null {
  if (!market) return null
  const pick = (...values: (number | null | undefined)[]) => values.find((v): v is number => typeof v === "number" && Number.isFinite(v)) ?? null
  const mid = pick(market.mid) ?? (typeof market.bid === "number" && typeof market.ask === "number" ? (market.bid + market.ask) / 2 : null)
  if (field === "bid") return pick(market.bid, mid, market.last)
  if (field === "ask") return pick(market.ask, mid, market.last)
  // A price on a ticket: a buyer measures against the offer, a seller against the bid.
  if (side === "buy") return pick(market.ask, mid, market.last)
  if (side === "sell") return pick(market.bid, mid, market.last)
  return pick(mid, market.last)
}

/** How far a level is from a market level in the convention's unit: ticks for a price basis, basis points for the rest. */
export function distanceFromMarket(level: number, market: number, convention: InstrumentConvention | undefined): { value: number; unit: "ticks" | "bps" } {
  if (!convention || quoteBasisOf(convention) === "price") return { value: Math.abs(ticksBetween(level, market, convention?.tick ?? 1)), unit: "ticks" }
  // A yield or a discount is quoted in percent, so a hundredth of a point is a basis point; a spread is quoted in basis points already.
  const perPoint = quoteBasisOf(convention) === "spread" ? 1 : 100
  // To a thousandth of a basis point, so 4.30 against 4.25 is 5 and not 4.999999999999982.
  return { value: Math.round(Math.abs(level - market) * perPoint * 1000) / 1000, unit: "bps" }
}

/**
 * What the limits say about a draft, in the tickets' shape, each with its level and a sentence. Empty
 * when nothing does. Quantity against the lines, each level against the market in the instrument's
 * unit, the side against the sides the book takes, then your own rules.
 */
export function checkLimits(draft: LimitsDraft, limits: Limits | undefined, context: LimitsContext = {}): Problem[] {
  if (!limits) return []
  const labels = { ...DEFAULT_LIMITS_LABELS, ...context.labels }
  const problems: Problem[] = []
  const quantity = draft.quantity
  if (typeof quantity === "number" && Number.isFinite(quantity)) {
    const max = thresholds(limits.maxQuantity)
    if (max.block !== undefined && quantity > max.block) problems.push({ field: "quantity", level: "block", rule: "maxQuantity", message: fill(labels.quantityAbove, { n: formatQuantity(quantity), max: formatQuantity(max.block) }) })
    else if (max.confirm !== undefined && quantity > max.confirm) problems.push({ field: "quantity", level: "confirm", rule: "maxQuantity", message: fill(labels.quantityAboveConfirm, { n: formatQuantity(quantity), max: formatQuantity(max.confirm) }) })
    const min = thresholds(limits.minQuantity)
    if (min.block !== undefined && quantity < min.block) problems.push({ field: "quantity", level: "block", rule: "minQuantity", message: fill(labels.quantityBelow, { n: formatQuantity(quantity), min: formatQuantity(min.block) }) })
    else if (min.confirm !== undefined && quantity < min.confirm) problems.push({ field: "quantity", level: "confirm", rule: "minQuantity", message: fill(labels.quantityBelowConfirm, { n: formatQuantity(quantity), min: formatQuantity(min.confirm) }) })
  }
  if (limits.maxDistance) {
    const rule = limits.maxDistance
    const level = rule.level ?? "block"
    const max = "ticks" in rule ? { value: rule.ticks, unit: "ticks" as const } : { value: rule.bps, unit: "bps" as const }
    for (const field of ["price", "bid", "ask"] as const) {
      const value = draft[field]
      if (typeof value !== "number" || !Number.isFinite(value)) continue
      const against = marketSideFor(field, draft.side, context.market)
      if (against === null) continue
      const distance = distanceFromMarket(value, against, context.convention)
      if (distance.unit !== max.unit || !(distance.value > max.value)) continue
      const unit = labels[max.unit]
      const words = { field, distance: `${formatTicks(distance.value, { signed: false })} ${unit}`, max: `${formatTicks(max.value, { signed: false })} ${unit}` }
      problems.push({ field, level, rule: "maxDistance", message: fill(level === "block" ? labels.tooFar : labels.tooFarConfirm, words) })
    }
  }
  if (limits.sides) {
    const taken = new Set(limits.sides)
    const refuse = (side: "buy" | "sell", field: string) => problems.push({ field, level: "block", rule: "sides", message: fill(labels.sideNotAllowed, { side: labels[side] }) })
    if (draft.side && !taken.has(draft.side)) refuse(draft.side, "side")
    if (typeof draft.bid === "number" && !taken.has("buy")) refuse("buy", "bid")
    if (typeof draft.ask === "number" && !taken.has("sell")) refuse("sell", "ask")
  }
  if (limits.custom) problems.push(...limits.custom(draft, context))
  return problems
}

/** The problems that stop the action. */
export function blocks(problems: readonly Problem[]): Problem[] {
  return problems.filter((p) => p.level === "block")
}

/** The problems that ask again. */
export function confirms(problems: readonly Problem[]): Problem[] {
  return problems.filter((p) => p.level === "confirm")
}

/** The first message per field, for printing under the fields the way the tickets do. */
export function problemsByField(problems: readonly Problem[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of problems) if (!(p.field in out)) out[p.field] = p.message
  return out
}
