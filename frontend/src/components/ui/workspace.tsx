import { cn } from "cn"
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type DockviewTheme, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type SerializedDockview } from "dockview-react"
import "dockview-react/dist/styles/dockview.css"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ComponentType, type ReactNode } from "react"
import { useMaybeHotkeys } from "@/hooks/use-hotkeys"
import { mirrorRoot } from "@/hooks/use-popout"
import {
  createWorkspacePanelStore,
  debounce,
  nextPanelId,
  parseWorkspaceLayout,
  WORKSPACE_LAYOUT_KIND,
  WORKSPACE_LAYOUT_VERSION,
  WORKSPACE_PERSISTENCE_BOUNDARIES,
  type WorkspaceDockLayout,
  type WorkspaceLayout,
  type WorkspacePanelState,
  type WorkspacePanelStatePatch,
  type WorkspacePanelStore,
} from "@/lib/workspace-layout"
import { Panel } from "@/components/ui/panel"

// Panels that dock, tab, float, and pop out, on dockview.
//
// The dock owns where things sit. tradecn owns what each panel is: a kind, a title, and a little
// JSON the panel asked to keep. Every docked panel is wrapped in a `Panel`, so it is the hotkey
// scope `panel:<kind>` and wears the active border, and the dock decides which one is active.
//
// Nothing is persisted here. `onLayoutChange` hands over a layout some milliseconds after the last
// change, and `defaultLayout` takes one back.

// The class the registry item's `css` maps onto your shadcn tokens. No `colorScheme`: that is your app's to say.
const THEME: DockviewTheme = { name: "tradecn", className: "dockview-theme-tradecn" }
const PANEL_COMPONENT = "tradecn-panel"

export type WorkspacePanelLocation = "grid" | "floating" | "popout" | "edge"

export interface WorkspacePanelProps {
  id: string
  kind: string
}

export interface WorkspacePanelInfo {
  id: string
  kind: string
  title: string
  active: boolean
  location: WorkspacePanelLocation
}

export interface WorkspaceBox {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface WorkspaceAddPanelOptions {
  kind: string
  /** `book-1`, `book-2` by default. An id that is already open is focused, not opened twice. */
  id?: string
  /** The kind by default. */
  title?: string
  state?: WorkspacePanelState
  /** Beside another panel, or as a tab with it (`within`). Left out, it joins the active group. */
  position?: { reference?: string; direction: "left" | "right" | "above" | "below" | "within" }
  /** Open it floating instead. */
  floating?: boolean | WorkspaceBox
  /** Move the keyboard to it once it has rendered. Default true. */
  focus?: boolean
}

export interface WorkspaceApi {
  /** Returns the panel's id. */
  addPanel(options: WorkspaceAddPanelOptions): string
  closePanel(id: string): void
  /** Makes it the active panel and puts the keyboard inside it, so the keys of `panel:<kind>` answer. */
  focusPanel(id: string): void
  /** The next panel in the dock's own order, or the one before with -1. */
  focusNext(step?: 1 | -1): void
  panels(): WorkspacePanelInfo[]
  activePanel(): string | null
  setTitle(id: string, title: string): void
  getState(id: string): WorkspacePanelState | undefined
  setState(id: string, patch: WorkspacePanelStatePatch | ((state: WorkspacePanelState) => WorkspacePanelStatePatch)): void
  float(id: string, box?: WorkspaceBox): void
  /** A window of its own. False when the browser blocked it. Has to run inside a click or a key press. */
  popout(id: string): Promise<boolean>
  toggleMaximize(id: string): void
  toLayout(): WorkspaceLayout
  /** Replaces everything with a stored layout. False, and an empty workspace, when it does not parse or the dock refuses it. */
  load(layout: unknown): boolean
  clear(): void
  /** The dock's own API, for what this one does not cover. */
  readonly dockview: DockviewApi
}

export interface WorkspacePanelHandle extends WorkspacePanelInfo {
  state: WorkspacePanelState
  setTitle(title: string): void
  /** Merges into what the panel keeps across a reload. Small and JSON. */
  setState(patch: WorkspacePanelStatePatch | ((state: WorkspacePanelState) => WorkspacePanelStatePatch)): void
  close(): void
  float(box?: WorkspaceBox): void
  popout(): Promise<boolean>
  toggleMaximize(): void
}

interface WorkspaceContextValue {
  store: WorkspacePanelStore
  kinds: Record<string, ComponentType<WorkspacePanelProps>>
  api: WorkspaceApi | null
  watermark: ReactNode
  /** The panel's element, once it has one. Returns the unregister. */
  registerHost(id: string, element: HTMLElement): () => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)
const WorkspacePanelContext = createContext<WorkspacePanelHandle | null>(null)

/** The panel this component is drawn in: its id, kind, title, kept state, and what the dock can do with it. */
export function useWorkspacePanel(): WorkspacePanelHandle {
  const panel = useContext(WorkspacePanelContext)
  if (!panel) throw new Error("useWorkspacePanel must be called inside a panel of a <Workspace>")
  return panel
}

function locationOf(api: IDockviewPanelProps["api"]): WorkspacePanelLocation {
  return api.location.type
}

interface Internals {
  api: WorkspaceApi
  registerHost: WorkspaceContextValue["registerHost"]
  dispose(): void
}

interface Callbacks {
  onLayoutChange?: (layout: WorkspaceLayout) => void
  onLayoutError?: (reason: unknown) => void
  popoutUrl?: string
}

function connect(dv: DockviewApi, store: WorkspacePanelStore, callbacks: () => Callbacks, delay: number): Internals {
  // Loading replaces every panel, and the dock reports each removal and each change as it goes.
  let loading = false
  let wantsFocus: string | null = null
  const hosts = new Map<string, HTMLElement>()

  const focusHost = (id: string) => {
    const target = hosts.get(id)?.firstElementChild
    if (target instanceof (target?.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)) target.focus({ preventScroll: true })
  }

  const toLayout = (): WorkspaceLayout => {
    const dockview = dv.toJSON()
    const records = store.snapshot()
    const panels = Object.fromEntries(Object.keys(dockview.panels).flatMap((id) => (records[id] ? [[id, records[id]] as const] : [])))
    return { version: WORKSPACE_LAYOUT_VERSION, kind: WORKSPACE_LAYOUT_KIND, dockview: dockview as unknown as WorkspaceDockLayout, panels, boundaries: WORKSPACE_PERSISTENCE_BOUNDARIES }
  }

  // What was last handed over or loaded, so an event that changed nothing, such as the dock's own
  // pass after a restore, is not a save.
  let written = ""
  const save = debounce(() => {
    const { onLayoutChange } = callbacks()
    if (!onLayoutChange) return
    // The dock may already be gone when the last change is flushed on the way out.
    try {
      const layout = toLayout()
      const text = JSON.stringify(layout)
      if (text === written) return
      written = text
      onLayoutChange(layout)
    } catch (reason) {
      callbacks().onLayoutError?.(reason)
    }
  }, delay)
  const changed = () => {
    if (!loading) save()
  }

  const info = (id: string): WorkspacePanelInfo | null => {
    const panel = dv.getPanel(id)
    const record = store.get(id)
    if (!panel || !record) return null
    return { id, kind: record.kind, title: record.title, active: dv.activePanel?.id === id, location: locationOf(panel.api) }
  }

  const api: WorkspaceApi = {
    addPanel({ kind, id: wanted, title, state, position, floating, focus = true }) {
      const id = wanted ?? nextPanelId(kind, dv.panels.map((panel) => panel.id))
      if (dv.getPanel(id)) {
        api.focusPanel(id)
        return id
      }
      const record = { kind, title: title ?? kind, state: state ?? {} }
      store.set(id, record)
      if (focus) wantsFocus = id
      try {
        const base = { id, component: PANEL_COMPONENT, title: record.title }
        if (floating) dv.addPanel({ ...base, floating: floating === true ? true : floating })
        else if (position) dv.addPanel({ ...base, position: position.reference ? { referencePanel: position.reference, direction: position.direction } : { direction: position.direction } })
        else dv.addPanel(base)
      } catch (reason) {
        store.delete(id)
        wantsFocus = null
        throw reason
      }
      return id
    },
    closePanel(id) {
      dv.getPanel(id)?.api.close()
    },
    focusPanel(id) {
      const panel = dv.getPanel(id)
      if (!panel) return
      panel.api.setActive()
      focusHost(id)
    },
    focusNext(step = 1) {
      if (step === 1) dv.moveToNext({ includePanel: true })
      else dv.moveToPrevious({ includePanel: true })
      const id = dv.activePanel?.id
      if (id) focusHost(id)
    },
    panels: () => dv.panels.flatMap((panel) => info(panel.id) ?? []),
    activePanel: () => dv.activePanel?.id ?? null,
    setTitle(id, title) {
      store.setTitle(id, title)
    },
    getState: (id) => store.get(id)?.state,
    setState(id, patch) {
      store.setState(id, patch)
    },
    float(id, box) {
      const panel = dv.getPanel(id)
      if (panel) dv.addFloatingGroup(panel, box)
    },
    async popout(id) {
      const panel = dv.getPanel(id)
      if (!panel) return false
      return dv.addPopoutGroup(panel, { popoutUrl: callbacks().popoutUrl })
    },
    toggleMaximize(id) {
      const panel = dv.getPanel(id)
      if (!panel) return
      if (panel.api.isMaximized()) panel.api.exitMaximized()
      else panel.api.maximize()
    },
    toLayout,
    load(value) {
      const layout = parseWorkspaceLayout(value)
      loading = true
      try {
        if (!layout) throw new Error("not a version 1 tradecn workspace layout")
        store.replace(layout.panels)
        dv.fromJSON(layout.dockview as unknown as SerializedDockview)
        written = JSON.stringify(toLayout())
        return true
      } catch (reason) {
        dv.clear()
        store.replace({})
        callbacks().onLayoutError?.(reason)
        return false
      } finally {
        loading = false
      }
    },
    clear() {
      dv.clear()
    },
    dockview: dv,
  }

  // The store is where a title lives; the dock draws it in places this file does not render, such as the overflow list.
  const syncTitles = () => {
    for (const panel of dv.panels) {
      const title = store.get(panel.id)?.title
      if (title && panel.title !== title) panel.api.setTitle(title)
    }
  }

  const disposables = [
    dv.onDidLayoutChange(changed),
    dv.onDidRemovePanel((panel) => {
      if (loading) return
      hosts.delete(panel.id)
      store.delete(panel.id)
    }),
    dv.onDidLayoutFromJSON(syncTitles),
  ]
  const unsubscribe = store.subscribe(() => {
    syncTitles()
    changed()
  })

  return {
    api,
    registerHost(id, element) {
      hosts.set(id, element)
      if (wantsFocus === id) {
        wantsFocus = null
        focusHost(id)
      }
      return () => {
        if (hosts.get(id) === element) hosts.delete(id)
      }
    },
    dispose() {
      save.flush()
      unsubscribe()
      for (const d of disposables) d.dispose()
    },
  }
}

export interface WorkspaceProps extends Omit<ComponentProps<"div">, "children" | "ref"> {
  /** What draws each kind of panel. Keep it the same object between renders: every panel re-renders when it changes. */
  panels: Record<string, ComponentType<WorkspacePanelProps>>
  /** A stored layout, read once as the workspace mounts. Anything that does not parse falls through to `seed`. */
  defaultLayout?: unknown
  /** Builds the starting layout when there is none to restore. */
  seed?: (api: WorkspaceApi) => void
  /** The layout, some milliseconds after the last change to it. Saving it is yours. */
  onLayoutChange?: (layout: WorkspaceLayout) => void
  /** How long a burst of changes has to go quiet. Default 250. */
  layoutChangeDelay?: number
  /** A stored layout was refused, or a layout could not be written out. */
  onLayoutError?: (reason: unknown) => void
  onReady?: (api: WorkspaceApi) => void
  /** Shown while there are no panels. */
  watermark?: ReactNode
  /** No dragging and no resizing. */
  locked?: boolean
  disableFloating?: boolean
  /** The same-origin page a popout opens. The dock's default is `/popout.html`, and it has to exist. */
  popoutUrl?: string
}

export function Workspace({ panels, defaultLayout, seed, onLayoutChange, layoutChangeDelay = 250, onLayoutError, onReady, watermark = null, locked, disableFloating, popoutUrl, className, ...props }: WorkspaceProps) {
  const [store] = useState(createWorkspacePanelStore)
  const [internals, setInternals] = useState<Internals | null>(null)
  const latest = useRef({ defaultLayout, seed, onLayoutChange, onLayoutError, onReady, layoutChangeDelay, popoutUrl })
  useEffect(() => {
    latest.current = { defaultLayout, seed, onLayoutChange, onLayoutError, onReady, layoutChangeDelay, popoutUrl }
  })
  const live = useRef<Internals | null>(null)
  // The last change is written out before the dock goes: a parent's cleanup runs ahead of its child's.
  useEffect(
    () => () => {
      live.current?.dispose()
      live.current = null
    },
    [],
  )

  const ready = useCallback(
    (event: DockviewReadyEvent) => {
      live.current?.dispose()
      const next = connect(event.api, store, () => latest.current, latest.current.layoutChangeDelay)
      live.current = next
      setInternals(next)
      const { defaultLayout: stored, seed: build, onReady: tell } = latest.current
      const restored = stored !== undefined && stored !== null && next.api.load(stored)
      if (!restored) build?.(next.api)
      tell?.(next.api)
    },
    [store],
  )

  const context = useMemo<WorkspaceContextValue>(
    () => ({ store, kinds: panels, api: internals?.api ?? null, watermark, registerHost: (id, element) => internals?.registerHost(id, element) ?? (() => {}) }),
    [store, panels, internals, watermark],
  )

  return (
    <WorkspaceContext.Provider value={context}>
      <div data-slot="tradecn-workspace" className={cn("relative h-full min-h-0 w-full min-w-0 lining-nums tabular-nums", className)} {...props}>
        <DockviewReact
          components={COMPONENTS}
          defaultTabComponent={WorkspaceTab}
          watermarkComponent={WorkspaceWatermark}
          theme={THEME}
          locked={locked}
          disableFloatingGroups={disableFloating}
          popoutUrl={popoutUrl}
          onReady={ready}
        />
      </div>
    </WorkspaceContext.Provider>
  )
}

function useWorkspaceContext(): WorkspaceContextValue {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error("a workspace panel was rendered outside a <Workspace>")
  return workspace
}

function WorkspacePanelHost({ api: panelApi }: IDockviewPanelProps) {
  const { store, kinds, api, registerHost } = useWorkspaceContext()
  const hotkeys = useMaybeHotkeys()
  const id = panelApi.id
  const getRecord = useCallback(() => store.get(id), [store, id])
  const record = useSyncExternalStore(store.subscribe, getRecord, getRecord)

  const subscribe = useCallback(
    (cb: () => void) => {
      const disposables = [panelApi.onDidActiveChange(cb), panelApi.onDidActiveGroupChange(cb), panelApi.onDidLocationChange(cb)]
      return () => {
        for (const d of disposables) d.dispose()
      }
    },
    [panelApi],
  )
  const active = useSyncExternalStore(
    subscribe,
    () => panelApi.isActive && panelApi.isGroupActive,
    () => false,
  )
  const location = useSyncExternalStore(
    subscribe,
    () => locationOf(panelApi),
    () => "grid" as const,
  )

  const [element, setElement] = useState<HTMLDivElement | null>(null)
  useEffect(() => (element ? registerHost(id, element) : undefined), [registerHost, id, element])

  // A popout is another document in the same JavaScript: it needs the keys, and the root element's
  // attributes, which is where a theme class lives. The dock copies the stylesheets itself.
  const popoutDocument = location === "popout" && element && element.ownerDocument !== document ? element.ownerDocument : null
  useEffect(() => (hotkeys && popoutDocument ? hotkeys.attach(popoutDocument) : undefined), [hotkeys, popoutDocument])
  useEffect(() => {
    if (!popoutDocument) return
    mirrorRoot(document, popoutDocument)
    if (typeof MutationObserver === "undefined") return
    const observer = new MutationObserver(() => mirrorRoot(document, popoutDocument))
    observer.observe(document.documentElement, { attributes: true })
    return () => observer.disconnect()
  }, [popoutDocument])

  const handle = useMemo<WorkspacePanelHandle | null>(
    () =>
      api && record
        ? {
            id,
            kind: record.kind,
            title: record.title,
            state: record.state,
            active,
            location,
            setTitle: (title) => api.setTitle(id, title),
            setState: (patch) => api.setState(id, patch),
            close: () => api.closePanel(id),
            float: (box) => api.float(id, box),
            popout: () => api.popout(id),
            toggleMaximize: () => api.toggleMaximize(id),
          }
        : null,
    [api, record, id, active, location],
  )
  if (!handle) return null
  const Component = kinds[handle.kind]

  return (
    <WorkspacePanelContext.Provider value={handle}>
      <div ref={setElement} data-workspace-panel={id} className="contents">
        <Panel kind={handle.kind} active={active} aria-label={handle.title} className="h-full rounded-none border-transparent">
          {Component ? <Component id={id} kind={handle.kind} /> : <p className="m-auto p-4 text-center text-xs text-muted-foreground">No panel is registered for the kind “{handle.kind}”.</p>}
        </Panel>
      </div>
    </WorkspacePanelContext.Provider>
  )
}

function WorkspaceTab({ api: panelApi }: IDockviewPanelHeaderProps) {
  const { api } = useWorkspaceContext()
  const subscribe = useCallback(
    (cb: () => void) => {
      const d = panelApi.onDidTitleChange(cb)
      return () => d.dispose()
    },
    [panelApi],
  )
  const title = useSyncExternalStore(
    subscribe,
    () => panelApi.title ?? panelApi.id,
    () => panelApi.id,
  )
  return (
    // The dock made this panel active on pointer down. The click that follows aims the keyboard at it.
    <div data-workspace-tab={panelApi.id} className="flex h-full items-center gap-1.5 text-xs" onClick={() => api?.focusPanel(panelApi.id)}>
      <span className="truncate">{title}</span>
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="-mr-1 inline-flex size-4 items-center justify-center rounded-sm leading-none text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={(event) => {
          event.stopPropagation()
          panelApi.close()
        }}
      >
        ×
      </button>
    </div>
  )
}

function WorkspaceWatermark() {
  const { watermark } = useWorkspaceContext()
  return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{watermark}</div>
}

const COMPONENTS = { [PANEL_COMPONENT]: WorkspacePanelHost }
