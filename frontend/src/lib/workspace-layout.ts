export const WORKSPACE_LAYOUT_KIND = "tradecn-workspace"
export const WORKSPACE_LAYOUT_VERSION = 1

export const WORKSPACE_PERSISTENCE_BOUNDARIES = {
  /** In the layout. `onLayoutChange` hands over a fresh one when any of these changes. */
  autosave: ["dock-arrangement", "floating-and-popout-positions", "panel-kinds", "panel-titles", "panel-state"],
  /** Belongs to one workspace and is not in the layout. Store it beside the layout, keyed by panel id. */
  workspaceScoped: ["grid-column-state", "selection", "scroll-position", "ticket-drafts"],
  /** Belongs to the person, whichever workspace is open. */
  globalScoped: ["hotkey-remaps", "palette-recents", "theme", "instrument-conventions"],
  /** Stored by nobody. It comes from the server every time. */
  excluded: ["market-data", "orders-and-status", "positions", "feed-health", "link-group-symbols"],
} as const

export type WorkspaceBoundary = keyof typeof WORKSPACE_PERSISTENCE_BOUNDARIES

export type WorkspacePersistenceBoundaries = { readonly [K in WorkspaceBoundary]: readonly string[] }

const BOUNDARY_KEYS = Object.keys(WORKSPACE_PERSISTENCE_BOUNDARIES) as WorkspaceBoundary[]

export type WorkspaceJson = string | number | boolean | null | WorkspaceJson[] | { [key: string]: WorkspaceJson }

/** What a panel keeps across a reload. Small and JSON: a symbol, a link group, a view setting. */
export type WorkspacePanelState = { [key: string]: WorkspaceJson }

export interface WorkspacePanelRecord {
  /** Which of the workspace's `panels` draws it, and the hotkey scope `panel:<kind>`. */
  kind: string
  title: string
  state: WorkspacePanelState
}

export interface WorkspaceLayout {
  version: typeof WORKSPACE_LAYOUT_VERSION
  kind: typeof WORKSPACE_LAYOUT_KIND
  /** The dock's own serialized form. Opaque here: read `panels` instead. */
  dockview: WorkspaceDockLayout
  /** One record per panel id in `dockview`. */
  panels: Record<string, WorkspacePanelRecord>
  /** What the writer included and what it kept out, at the time it wrote. */
  boundaries: WorkspacePersistenceBoundaries
}

/** As much of the dock's format as this file checks. */
export interface WorkspaceDockLayout {
  grid: { root: unknown; [key: string]: unknown }
  panels: Record<string, unknown>
  [key: string]: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The value as JSON would store it: functions and undefined are gone, and anything that cannot be stored is an empty state. */
export function toPanelState(value: unknown): WorkspacePanelState {
  if (!isObject(value)) return {}
  try {
    const stored: unknown = JSON.parse(JSON.stringify(value))
    return isObject(stored) ? (stored as WorkspacePanelState) : {}
  } catch {
    return {}
  }
}

function readBoundaries(value: unknown): WorkspacePersistenceBoundaries {
  if (!isObject(value)) return WORKSPACE_PERSISTENCE_BOUNDARIES
  const out = {} as Record<WorkspaceBoundary, readonly string[]>
  for (const key of BOUNDARY_KEYS) {
    const list = value[key]
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) return WORKSPACE_PERSISTENCE_BOUNDARIES
    out[key] = [...(list as string[])]
  }
  return out
}

/**
 * A stored layout, checked. Takes the object or the JSON text of one, and returns null for anything
 * that is not a version 1 tradecn workspace whose every docked panel has a record saying what kind
 * it is. A record with no panel in the dock is dropped. What comes back is a copy.
 */
export function parseWorkspaceLayout(value: unknown): WorkspaceLayout | null {
  let raw = value
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isObject(raw) || raw.kind !== WORKSPACE_LAYOUT_KIND || raw.version !== WORKSPACE_LAYOUT_VERSION) return null
  const dock = raw.dockview
  if (!isObject(dock) || !isObject(dock.grid) || !("root" in dock.grid) || !isObject(dock.panels) || !isObject(raw.panels)) return null
  const panels: Record<string, WorkspacePanelRecord> = {}
  for (const id of Object.keys(dock.panels)) {
    const record = raw.panels[id]
    if (!isObject(record) || typeof record.kind !== "string" || !record.kind) return null
    panels[id] = { kind: record.kind, title: typeof record.title === "string" && record.title ? record.title : record.kind, state: toPanelState(record.state) }
  }
  let dockview: WorkspaceDockLayout
  try {
    dockview = JSON.parse(JSON.stringify(dock)) as WorkspaceDockLayout
  } catch {
    return null
  }
  return { version: WORKSPACE_LAYOUT_VERSION, kind: WORKSPACE_LAYOUT_KIND, dockview, panels, boundaries: readBoundaries(raw.boundaries) }
}

/** The kinds a layout asks for that are not among `kinds`. The workspace draws a placeholder for each; this is for saying so up front. */
export function unknownPanelKinds(layout: WorkspaceLayout, kinds: Iterable<string>): string[] {
  const known = new Set(kinds)
  return [...new Set(Object.values(layout.panels).map((record) => record.kind))].filter((kind) => !known.has(kind)).sort()
}

/** `book-1`, then `book-2`: the lowest number not taken. */
export function nextPanelId(kind: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let n = 1
  while (used.has(`${kind}-${n}`)) n += 1
  return `${kind}-${n}`
}

export type WorkspacePanelStatePatch = { [key: string]: WorkspaceJson | undefined }

export interface WorkspacePanelStore {
  /** The same object until this panel changes, so it is safe as a `useSyncExternalStore` snapshot. */
  get(id: string): WorkspacePanelRecord | undefined
  /** Adds the panel, or replaces its record. */
  set(id: string, record: WorkspacePanelRecord): void
  setTitle(id: string, title: string): void
  /** Merges a patch into the panel's state. A key set to undefined is removed. A patch that changes nothing tells nobody. */
  setState(id: string, patch: WorkspacePanelStatePatch | ((state: WorkspacePanelState) => WorkspacePanelStatePatch)): void
  delete(id: string): void
  /** Every record at once, for a layout being loaded. */
  replace(records: Record<string, WorkspacePanelRecord>): void
  ids(): string[]
  /** Copies, for writing out. */
  snapshot(): Record<string, WorkspacePanelRecord>
  subscribe(cb: () => void): () => void
}

export function createWorkspacePanelStore(): WorkspacePanelStore {
  let records = new Map<string, WorkspacePanelRecord>()
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const cb of [...listeners]) cb()
  }
  const clean = (record: WorkspacePanelRecord): WorkspacePanelRecord => ({ kind: record.kind, title: record.title || record.kind, state: toPanelState(record.state) })

  return {
    get: (id) => records.get(id),
    set(id, record) {
      records.set(id, clean(record))
      emit()
    },
    setTitle(id, title) {
      const record = records.get(id)
      if (!record || !title || record.title === title) return
      records.set(id, { ...record, title })
      emit()
    },
    setState(id, patch) {
      const record = records.get(id)
      if (!record) return
      const next = toPanelState({ ...record.state, ...(typeof patch === "function" ? patch(record.state) : patch) })
      if (JSON.stringify(next) === JSON.stringify(record.state)) return
      records.set(id, { ...record, state: next })
      emit()
    },
    delete(id) {
      if (records.delete(id)) emit()
    },
    replace(next) {
      records = new Map(Object.entries(next).map(([id, record]) => [id, clean(record)]))
      emit()
    },
    ids: () => [...records.keys()],
    snapshot: () => Object.fromEntries([...records].map(([id, record]) => [id, { ...record, state: toPanelState(record.state) }])),
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

export interface Debounced {
  (): void
  /** Run now if a run is waiting. */
  flush(): void
  cancel(): void
  pending(): boolean
}

/** One call `ms` after the last of a burst: a sash drag reports a change on every pointer move. */
export function debounce(fn: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = () => {
    timer = null
    fn()
  }
  const debounced = (() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, ms)
  }) as Debounced
  debounced.flush = () => {
    if (!timer) return
    clearTimeout(timer)
    run()
  }
  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  debounced.pending = () => timer !== null
  return debounced
}
