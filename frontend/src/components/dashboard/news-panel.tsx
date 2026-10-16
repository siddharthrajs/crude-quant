import { memo, useMemo } from "react"
import { cn } from "cn"
import { AlertBody, AlertHeader, AlertItem, AlertSeverity, AlertTitle, Alerts, AlertsEmpty, AlertsList } from "@/components/ui/alerts"
import { Button } from "@/components/ui/button"
import { PanelActions, PanelContent, PanelHeader } from "@/components/ui/panel"
import { useDashboardData } from "@/components/dashboard/dashboard-context"
import { useNow } from "@/hooks/use-clock"
import { useRow, useRowIds, useView } from "@/hooks/use-row-store"
import { byNewest, type Alert } from "@/lib/alert-store"
import type { RowView } from "@/lib/row-store"
import { useWorkspacePanel } from "@/components/ui/workspace"

type Filter = "all" | "oil_direct" | "geo_risk"
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "oil_direct", label: "Oil" },
  { id: "geo_risk", label: "Geo" },
]
/** A headline pushed this recently is shown as just in. */
const JUST_IN_MS = 10_000

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const NewsItem = memo(function NewsItem({ id }: { id: string }) {
  const { news } = useDashboardData()
  const alert = useRow(news.alerts.store, id)
  const now = useNow()
  if (!alert) return null
  const link = typeof alert.meta?.link === "string" ? alert.meta.link : null
  const receivedAt = typeof alert.meta?.receivedAt === "number" ? alert.meta.receivedAt : null
  const justIn = receivedAt !== null && now - receivedAt < JUST_IN_MS
  return (
    <AlertItem tone={alert.tone} className={cn("gap-0.5", justIn && "news-blip")}>
      <AlertHeader className="flex-nowrap items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">{clock.format(alert.at)}</span>
        <AlertSeverity tone={alert.tone}>{alert.severity}</AlertSeverity>
        {justIn && <span className="shrink-0 text-[10px] font-semibold tracking-wide text-destructive">NEW</span>}
        <span className="ml-auto shrink-0 text-muted-foreground">{ago(now - alert.at)}</span>
      </AlertHeader>
      <AlertTitle className="font-normal">
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className="outline-none hover:underline focus-visible:underline">
            {alert.title}
          </a>
        ) : (
          alert.title
        )}
      </AlertTitle>
      {alert.message && <AlertBody className="text-[11px]">{alert.message}</AlertBody>}
    </AlertItem>
  )
})

/** Live CNS headlines: Postgres NOTIFY → backend → websocket → a tradecn alert store, newest first. */
export function NewsPanel() {
  const { news } = useDashboardData()
  const panel = useWorkspacePanel()
  const filter = (typeof panel.state.filter === "string" ? panel.state.filter : "all") as Filter

  const options = useMemo(
    () => ({ comparator: byNewest, filter: filter === "all" ? undefined : (a: Alert) => a.meta?.category === filter }),
    [filter],
  )
  const view = useView(news.alerts.store, options)
  if (!view) return null
  return (
    <>
      <PanelHeader>
        <span className={cn("size-1.5 rounded-full", news.status === "open" ? "bg-up" : news.status === "connecting" ? "bg-stale" : "bg-destructive")} aria-hidden />
        <span className="text-muted-foreground">{news.status === "open" ? "Live" : news.status === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
        <PanelActions>
          {FILTERS.map((f) => (
            <Button key={f.id} type="button" size="sm" variant={filter === f.id ? "secondary" : "ghost"} className="h-5 px-1.5 text-xs" onClick={() => panel.setState({ filter: f.id })}>
              {f.label}
            </Button>
          ))}
        </PanelActions>
      </PanelHeader>
      <PanelContent className="p-1.5">
        {news.error && <p className="pb-1 text-xs text-destructive">{news.error}</p>}
        <NewsList view={view} />
      </PanelContent>
    </>
  )
}

function NewsList({ view }: { view: RowView<Alert> }) {
  const ids = useRowIds(view)
  return (
    <Alerts aria-label="News headlines" className="gap-1">
      {ids.length === 0 ? (
        <AlertsEmpty className="p-3 text-center">No headlines yet.</AlertsEmpty>
      ) : (
        <AlertsList className="gap-1">
          {ids.map((id) => (
            <NewsItem key={id} id={String(id)} />
          ))}
        </AlertsList>
      )}
    </Alerts>
  )
}
