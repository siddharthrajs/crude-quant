// QH strategy codes the Distribution view takes, listed so they can be searched by name: "wti spread c2",
// "brent fly dec26", "clbzz 1-2". Generic codes are by slot (CL1-2), running codes by contract (CLZ26-F27); the
// leg count is the structure (backend/app/routers/curve_lab_2_distribution.py).

import type { CurveLab2Mode } from "@/lib/curve-lab-2-api"

export interface StrategySuggestion {
  code: string
  /** "WTI spread c2-c3", "Brent fly Dec26 / Jan27 / Feb27". */
  label: string
  /** Lowercase words the search matches against. */
  words: string[]
  /** The front leg's words ("c2", "z26", "dec26"): a hit on these ranks first. */
  lead: string[]
}

const PRODUCTS = [
  { root: "CL", label: "WTI", aliases: ["wti", "cl", "nymex"] },
  { root: "CO", label: "Brent", aliases: ["brent", "co", "bz", "ice"] },
  { root: "WTCLCO", label: "CLBZZ", aliases: ["clbzz", "wtclco", "arb"] },
]

const STRUCTURES = [
  { legs: 1, label: "outright", aliases: ["outright", "flat", "single"] },
  { legs: 2, label: "spread", aliases: ["spread", "sprd", "spd", "calendar", "cal"] },
  { legs: 3, label: "fly", aliases: ["fly", "butterfly", "bf"] },
  { legs: 4, label: "dfly", aliases: ["dfly", "double", "doublefly", "condor"] },
]

const MONTH_CODES = "FGHJKMNQUVXZ"
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const GENERIC_SLOTS = 24
/** Running contracts listed beyond the range's end. */
const AHEAD_MONTHS = 24

const tenor = (key: number) => `${MONTH_CODES[key % 12]}${String(Math.floor(key / 12) % 100).padStart(2, "0")}`
const monthName = (key: number) => `${MONTH_NAMES[key % 12]}${String(Math.floor(key / 12) % 100).padStart(2, "0")}`
const keyOf = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1

/** Every adjacent-leg code for the mode: generic over c1…c24, running over the contracts trading in the range. */
export function strategySuggestions(mode: CurveLab2Mode, start: string, end: string): StrategySuggestion[] {
  const out: StrategySuggestion[] = []
  for (const s of STRUCTURES) {
    for (const p of PRODUCTS) {
      if (mode === "GD") {
        for (let k = 1; k + s.legs - 1 <= GENERIC_SLOTS; k++) {
          const slots = Array.from({ length: s.legs }, (_, i) => k + i)
          const legs = slots.map((n) => `c${n}`).join("-")
          out.push({
            code: `${p.root}${slots.join("-")}`,
            label: `${p.label} ${s.label} ${legs}`,
            words: [`${p.root}${slots.join("-")}`.toLowerCase(), ...p.aliases, ...s.aliases, legs, ...slots.map((n) => `c${n}`), String(k), slots.join("-")],
            lead: [`c${k}`, String(k)],
          })
        }
      } else {
        if (!start || !end) continue
        const first = keyOf(start)
        const last = keyOf(end) + AHEAD_MONTHS
        for (let k = first; k + s.legs - 1 <= last; k++) {
          const keys = Array.from({ length: s.legs }, (_, i) => k + i)
          const code = `${p.root}${keys.map(tenor).join("-")}`
          out.push({
            code,
            label: `${p.label} ${s.label} ${keys.map(monthName).join(" / ")}`,
            words: [code.toLowerCase(), ...p.aliases, ...s.aliases, ...keys.map((x) => tenor(x).toLowerCase()), ...keys.map((x) => monthName(x).toLowerCase()), keys.map(tenor).join("-").toLowerCase()],
            lead: [tenor(k).toLowerCase(), monthName(k).toLowerCase()],
          })
        }
      }
    }
  }
  return out
}

/**
 * The best `limit` matches for what was typed. Every word typed must match the start of one of a suggestion's
 * words (or appear in its code); a code starting with the query, then hits on the front leg, then whole-word hits
 * rank first. An empty query
 * lists the first few, so focusing the field already offers something.
 */
export function searchStrategies(all: StrategySuggestion[], query: string, limit = 12): StrategySuggestion[] {
  const q = query.trim().toLowerCase()
  if (!q) return all.slice(0, limit)
  const tokens = q.split(/[\s,/]+/).filter(Boolean)
  const compact = q.replace(/\s+/g, "")
  const scored: { s: StrategySuggestion; score: number; i: number }[] = []
  all.forEach((s, i) => {
    const code = s.code.toLowerCase()
    let score = code.startsWith(compact) ? 100 : 0
    for (const t of tokens) {
      if (s.lead.includes(t)) score += 15
      else if (s.words.includes(t)) score += 10
      else if (s.words.some((w) => w.startsWith(t)) || code.includes(t)) score += 1
      else return
    }
    scored.push({ s, score, i })
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, limit).map((x) => x.s)
}
