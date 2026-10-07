// Tenor-code arithmetic: a tenor is a futures month letter plus a 2-digit year, e.g. "X26" (Nov 2026).
// Mirrors the backend's `MONTH_CODE` in `backend/app/lightstreamer/instruments.py` -- keep in sync.

const MONTH_CODES = "FGHJKMNQUVXZ" // Jan..Dec

/** Absolute month index (year*12+month) so tenor arithmetic never has to special-case a year rollover. */
function toAbsoluteMonth(tenor: string): number | null {
  const letter = tenor[0]
  const monthIndex = MONTH_CODES.indexOf(letter)
  const yearPart = tenor.slice(1)
  if (monthIndex < 0 || !/^\d{2}$/.test(yearPart)) return null
  return Number(yearPart) * 12 + monthIndex
}

function fromAbsoluteMonth(absolute: number): string {
  const year = Math.floor(absolute / 12)
  const monthIndex = absolute - year * 12
  return `${MONTH_CODES[monthIndex]}${String(year).padStart(2, "0")}`
}

/** `addMonths("X26", 1)` is `"Z26"`; `addMonths("X26", -1)` is `"V26"`. Returns the input unchanged if it isn't a valid tenor. */
export function addMonths(tenor: string, months: number): string {
  const absolute = toAbsoluteMonth(tenor)
  if (absolute === null) return tenor
  return fromAbsoluteMonth(absolute + months)
}

/** Whole months from `a` to `b` (`monthsBetween("X26","Z26") === 1`), or `null` if either isn't a valid tenor. */
export function monthsBetween(a: string, b: string): number | null {
  const abs = toAbsoluteMonth(a)
  const bbs = toAbsoluteMonth(b)
  return abs === null || bbs === null ? null : bbs - abs
}
