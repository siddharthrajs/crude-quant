// A × B correlation grid on one day: A's points down the side, B's across the top, each labelled with its slot and
// that day's front contract. Cells blend from the muted surface toward --up (positive) or --down (negative) by
// strength, so the scale follows the theme. Outlined cells are the matched pairs (same slot, or same delivery
// month); the selected cell is ringed. Click a cell to select it.

export interface MatrixAxis {
  /** "WTI Spread" */
  label: string
  /** That day's front contract per point; "" past the end of the curve. */
  refs: string[]
}

/** Background and text for a value on a ±span scale; null for no value. */
function cellStyle(v: number | null, span: number): React.CSSProperties {
  if (v === null) return { background: "var(--muted)" }
  const f = Math.min(1, Math.abs(v) / span)
  const pct = Math.round(Math.pow(f, 0.85) * 100)
  return {
    background: `color-mix(in oklch, ${v >= 0 ? "var(--up)" : "var(--down)"} ${pct}%, var(--muted))`,
    color: pct > 55 ? "var(--background)" : undefined,
  }
}

const short = (v: number, signed: boolean) => `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}`.replace(/^([+-]?)0\./, "$1.").replace("-", "−")

export function CorrelationMatrix({
  rows,
  cols,
  value,
  span,
  signed,
  matched,
  selected,
  onSelect,
  describe,
}: {
  rows: MatrixAxis
  cols: MatrixAxis
  /** The cell's value, or null. */
  value: (i: number, j: number) => number | null
  /** Values at ±span get the full color. */
  span: number
  /** Show a + on positive values (for changes). */
  signed: boolean
  /** The column matched with row i, or -1. */
  matched: (i: number) => number
  selected: [number, number]
  onSelect: (i: number, j: number) => void
  /** Hover text for a cell. */
  describe: (i: number, j: number) => string
}) {
  const [si, sj] = selected
  return (
    <div className="overflow-auto">
      <table className="border-separate border-spacing-0.5 text-[11px] tabular-nums">
        <thead>
          <tr>
            <th colSpan={2} className="pr-1.5 pb-0.5 text-right align-bottom text-[10px] font-normal text-muted-foreground">
              {rows.label} ↓ · {cols.label} →
            </th>
            {cols.refs.map((ref, j) => (
              <th key={j} className={`px-0.5 pb-0.5 text-center align-bottom font-medium ${j === sj ? "text-foreground" : "text-muted-foreground"}`}>
                c{j + 1}
                <span className="block text-[9.5px] font-normal text-muted-foreground/70">{ref || "–"}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.refs.map((ref, i) => {
            const mj = matched(i)
            return (
              <tr key={i}>
                <th className={`pr-1 text-right font-medium ${i === si ? "text-foreground" : "text-muted-foreground"}`}>c{i + 1}</th>
                <th className="pr-1.5 text-left text-[9.5px] font-normal text-muted-foreground/70">{ref || "–"}</th>
                {cols.refs.map((_, j) => {
                  const v = value(i, j)
                  const sel = i === si && j === sj
                  return (
                    <td
                      key={j}
                      title={describe(i, j)}
                      onClick={() => onSelect(i, j)}
                      className={`relative h-7 w-10 cursor-pointer rounded-sm text-center ${v === null ? "text-muted-foreground/50" : ""} ${
                        j === mj ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]" : ""
                      } ${sel ? "z-10 outline-2 outline-offset-1 outline-foreground" : ""}`}
                      style={cellStyle(v, span)}
                    >
                      {v === null ? "–" : short(v, signed)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The color scale under the matrix: −span … +span. */
export function MatrixLegend({ span, signed, align }: { span: number; signed: boolean; align: "slot" | "month" }) {
  const end = (v: number) => short(v, signed)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5 tabular-nums">
        {end(-span)}
        <span className="h-2.5 w-36 rounded-sm" style={{ background: "linear-gradient(to right, var(--down), var(--muted), var(--up))" }} />
        {end(span)}
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-2.5 w-3.5 rounded-sm shadow-[inset_0_0_0_1.5px_var(--foreground)]" />
        {align === "slot" ? "same slot" : "same delivery month"}
      </span>
      <span>– : too few shared days in the window</span>
    </div>
  )
}
