import type { Matrix } from "@/lib/curve-lab-api"

// Fly-by-fly correlation grid. Cells are tinted green (positive) / red (negative) by strength; a pair with
// fewer than MIN_PAIRS shared days is greyed out, since a correlation on a handful of days is not information.
// The anchor's row and column are outlined so "what moves with the fly I am conditioning on" reads at a glance.

const MIN_PAIRS = 60

function tint(r: number): string {
  const hue = r >= 0 ? 150 : 25
  return `oklch(0.62 0.15 ${hue} / ${Math.min(1, Math.abs(r)) * 0.85})`
}

export function CorrelationHeatmap({ flies, matrix, anchor }: { flies: number[]; matrix: Matrix; anchor: number }) {
  return (
    <div className="overflow-auto">
      <table className="border-separate border-spacing-0.5 text-[11px] tabular-nums">
        <thead>
          <tr>
            <th />
            {flies.map((f) => (
              <th key={f} className={`px-1 pb-0.5 font-medium ${f === anchor ? "text-foreground" : "text-muted-foreground"}`}>
                F{f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {flies.map((row, i) => (
            <tr key={row}>
              <th className={`pr-1.5 text-right font-medium ${row === anchor ? "text-foreground" : "text-muted-foreground"}`}>F{row}</th>
              {flies.map((col, j) => {
                const r = matrix.corr[i][j]
                const n = matrix.n[i][j]
                const thin = r === null || n < MIN_PAIRS
                const onAnchor = row === anchor || col === anchor
                return (
                  <td
                    key={col}
                    title={`F${row} vs F${col}: ${r === null ? "n/a" : r.toFixed(2)} over ${n} days${thin && r !== null ? " (too few days)" : ""}`}
                    className={`h-7 w-9 rounded-sm text-center ${onAnchor ? "outline outline-1 outline-border" : ""} ${thin ? "text-muted-foreground/50" : ""}`}
                    style={{ background: r === null || thin ? "var(--muted)" : tint(r) }}
                  >
                    {r === null ? "–" : r.toFixed(2).replace(/^(-?)0\./, "$1.")}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
