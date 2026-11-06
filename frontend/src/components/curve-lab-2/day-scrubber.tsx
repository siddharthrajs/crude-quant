import { Button } from "@/components/ui/button"
import { SPEEDS, fieldClass, type Playback } from "./shared"

/** Prev / Play / Next, speed, and a slider over the days. */
export function DayScrubber({
  dates,
  playback,
  speedMs,
  onSpeed,
  className = "",
}: {
  dates: string[]
  playback: Playback
  speedMs: number
  onSpeed: (ms: number) => void
  className?: string
}) {
  const count = dates.length
  if (count === 0) return null
  const { index, playing } = playback
  return (
    <section className={`flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs ${className}`}>
      <Button size="xs" variant="outline" onClick={() => playback.step(-1)} disabled={index <= 0} aria-label="Previous day">
        ◀
      </Button>
      <Button size="xs" onClick={playback.play} className="w-14">
        {playing ? "Pause" : "Play"}
      </Button>
      <Button size="xs" variant="outline" onClick={() => playback.step(1)} disabled={index >= count - 1} aria-label="Next day">
        ▶
      </Button>
      <select className={fieldClass} value={speedMs} onChange={(e) => onSpeed(Number(e.target.value))} aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <option key={s.ms} value={s.ms}>
            {s.label}
          </option>
        ))}
      </select>
      <span className="tabular-nums text-muted-foreground">{dates[0]}</span>
      <input
        type="range"
        className="min-w-40 flex-1 accent-primary"
        min={0}
        max={count - 1}
        value={index}
        onChange={(e) => playback.pick(Number(e.target.value))}
        aria-label="Day"
        aria-valuetext={dates[index]}
      />
      <span className="tabular-nums text-muted-foreground">{dates[count - 1]}</span>
      <span className="w-36 text-right font-semibold tabular-nums">
        {dates[index]}{" "}
        <span className="font-normal text-muted-foreground">
          ({index + 1}/{count})
        </span>
      </span>
    </section>
  )
}
