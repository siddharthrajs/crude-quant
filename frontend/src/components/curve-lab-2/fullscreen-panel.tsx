import { useEffect, useRef, useState, type ReactNode } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// A bordered panel with a full-screen button in its top-right corner. Full screen is the browser's own (Fullscreen
// API) where it is allowed, else the panel covers the window; Esc leaves either. Children get `full` so a chart
// can fill the screen instead of its usual fixed height, and `controls` (e.g. the day slider) are shown above the
// content only while full screen, since the rest of the page is out of sight then.

export function FullscreenPanel({ children, controls, className }: { children: (full: boolean) => ReactNode; controls?: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  const [native, setNative] = useState(false)
  const [overlay, setOverlay] = useState(false)
  const full = native || overlay

  useEffect(() => {
    const sync = () => setNative(document.fullscreenElement === ref.current && ref.current !== null)
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [])

  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverlay(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [overlay])

  const toggle = () => {
    if (native) void document.exitFullscreen()
    else if (overlay) setOverlay(false)
    else if (ref.current?.requestFullscreen) ref.current.requestFullscreen().catch(() => setOverlay(true))
    else setOverlay(true)
  }

  return (
    <section
      ref={ref}
      className={cn(
        "relative rounded-md border border-border p-2",
        full && "flex h-full w-full flex-col gap-2 overflow-auto rounded-none border-0 bg-background p-4 text-foreground",
        overlay && "fixed inset-0 z-50",
        className,
      )}
    >
      <Button size="icon-xs" variant="ghost" className="absolute top-1.5 right-1.5 z-10" onClick={toggle} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (Esc)" : "Full screen"}>
        {full ? <Minimize2 /> : <Maximize2 />}
      </Button>
      {full && controls}
      {children(full)}
    </section>
  )
}
