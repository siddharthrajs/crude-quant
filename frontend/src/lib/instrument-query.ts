export type QueryKind = "cusip" | "isin" | "coupon-maturity" | "ticker" | "text" | "empty"

export interface QueryHint {
  kind: QueryKind
  /** The query with its spaces and case settled: a CUSIP or ISIN upper-cased, a ticker upper-cased. */
  normalized: string
  cusip?: string
  isin?: string
  ticker?: string
  /** The coupon as a number, 4.125 for "4 1/8". */
  coupon?: number
  /** The maturity as typed, settled to MM/YY or MM/DD/YY or the full date, whichever was given. */
  maturity?: string
  /** The maturity's month, day (when given), and two- or four-digit year, as numbers. */
  maturityParts?: { month: number; day?: number; year: number }
}

const CUSIP_VALUES: Record<string, number> = { "*": 36, "@": 37, "#": 38 }

/** A character's value in a CUSIP: digits as they are, letters 10 to 35, then *, @, #. */
function cusipValue(ch: string): number | null {
  if (/[0-9]/.test(ch)) return Number(ch)
  if (/[A-Z]/.test(ch)) return ch.charCodeAt(0) - 55
  return CUSIP_VALUES[ch] ?? null
}

/** Nine characters whose ninth is the modulus-10 double-add-double check digit of the first eight. */
export function isCusip(text: string): boolean {
  const s = text.trim().toUpperCase()
  if (!/^[0-9A-Z*@#]{8}[0-9]$/.test(s)) return false
  let sum = 0
  for (let i = 0; i < 8; i++) {
    let v = cusipValue(s[i]!)
    if (v === null) return false
    if (i % 2 === 1) v *= 2
    sum += Math.floor(v / 10) + (v % 10)
  }
  return (10 - (sum % 10)) % 10 === Number(s[8])
}

/** Twelve characters, two letters of country, nine of identifier, and a Luhn check digit over the letters expanded to numbers. */
export function isIsin(text: string): boolean {
  const s = text.trim().toUpperCase()
  if (!/^[A-Z]{2}[0-9A-Z]{9}[0-9]$/.test(s)) return false
  const digits = [...s].map((ch) => (/[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55))).join("")
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

const EIGHTHS: Record<string, number> = { "1/8": 0.125, "1/4": 0.25, "3/8": 0.375, "1/2": 0.5, "5/8": 0.625, "3/4": 0.75, "7/8": 0.875 }

/** A coupon as a run prints it, "4 1/8", "4.125", "4", "4½" spelled with a slash: the number, or null. */
export function parseCoupon(text: string): number | null {
  const s = text.trim()
  const mixed = /^(\d{1,2})(?:\s+(\d\/\d))?$/.exec(s)
  if (mixed) {
    const whole = Number(mixed[1])
    if (!mixed[2]) return whole
    const eighth = EIGHTHS[mixed[2]]
    return eighth === undefined ? null : whole + eighth
  }
  const fraction = /^(\d\/\d)$/.exec(s)
  if (fraction) return EIGHTHS[fraction[1]!] ?? null
  const decimal = /^(\d{1,2}(?:\.\d{1,3})?)%?$/.exec(s)
  if (decimal) return Number(decimal[1])
  return null
}

/** A maturity as typed after a coupon: MM/YY, MM/YYYY, MM/DD/YY, MM/DD/YYYY, or an ISO date. */
export function parseMaturity(text: string): { month: number; day?: number; year: number; text: string } | null {
  const s = text.trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (iso) {
    const [, y, m, d] = iso
    return { month: Number(m), day: Number(d), year: Number(y), text: s }
  }
  const slashed = /^(\d{1,2})\/(?:(\d{1,2})\/)?(\d{2}|\d{4})$/.exec(s)
  if (!slashed) return null
  const month = Number(slashed[1])
  const day = slashed[2] === undefined ? undefined : Number(slashed[2])
  const year = Number(slashed[3])
  if (month < 1 || month > 12 || (day !== undefined && (day < 1 || day > 31))) return null
  return { month, day, year, text: s }
}

/** "4 1/8 05/34", "4.125 5/15/2034", "T 4 1/8 05/15/34": a coupon and a maturity, or null. A leading word is a prefix the server may know. */
export function parseCouponMaturity(text: string): { coupon: number; maturity: string; maturityParts: { month: number; day?: number; year: number }; prefix?: string } | null {
  const words = text.trim().split(/\s+/)
  if (words.length < 2) return null
  const maturityWord = words[words.length - 1]!
  const maturity = parseMaturity(maturityWord)
  if (!maturity) return null
  const rest = words.slice(0, -1)
  // The coupon is the last one or two words before the maturity; anything before that is a prefix.
  for (const take of [2, 1]) {
    if (rest.length < take) continue
    const coupon = parseCoupon(rest.slice(rest.length - take).join(" "))
    if (coupon === null) continue
    const prefix = rest.slice(0, rest.length - take).join(" ")
    return { coupon, maturity: maturity.text, maturityParts: { month: maturity.month, day: maturity.day, year: maturity.year }, ...(prefix ? { prefix } : {}) }
  }
  return null
}

/** What the query looks like. Checked identifiers first, then a coupon-and-maturity phrase, then a ticker (letters and digits, up to twelve, one optional dot or dash), else text. */
export function recognizeQuery(text: string): QueryHint {
  const trimmed = text.trim().replace(/\s+/g, " ")
  if (!trimmed) return { kind: "empty", normalized: "" }
  const upper = trimmed.toUpperCase()
  if (isCusip(upper)) return { kind: "cusip", normalized: upper, cusip: upper }
  if (isIsin(upper)) return { kind: "isin", normalized: upper, isin: upper }
  const run = parseCouponMaturity(trimmed)
  if (run) return { kind: "coupon-maturity", normalized: trimmed, coupon: run.coupon, maturity: run.maturity, maturityParts: run.maturityParts, ...(run.prefix ? { ticker: run.prefix.toUpperCase() } : {}) }
  if (/^[A-Z][A-Z0-9]{0,11}(?:[.-][A-Z0-9]{1,4})?$/.test(upper)) return { kind: "ticker", normalized: upper, ticker: upper }
  return { kind: "text", normalized: trimmed }
}

export const QUERY_KIND_LABELS: Record<QueryKind, string> = {
  cusip: "CUSIP",
  isin: "ISIN",
  "coupon-maturity": "Coupon and maturity",
  ticker: "Ticker",
  text: "Text",
  empty: "",
}
