import { cn } from "cn"
import { useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react"
import { Badge } from "@/components/ui/badge"
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useMaybeHotkeys } from "@/hooks/use-hotkeys"
import { formatKeys, matchesKeys, scopeChain, type HotkeyEntry, type HotkeyRegistry, type Platform } from "@/lib/hotkeys"

// A command palette on the consumer's own shadcn `command`: actions from a registry, symbols from
// an adapter, and a second action per row on Shift+Enter (open, or open and add to the watchlist).
//
// Two variants share the registry, the rows, and the recents. `palette` is the dialog on mod+k.
// `go-bar` is the same thing inline, for terminals where the command line is always on screen, and
// it reads `<SYMBOL> <FUNCTION>` through a grammar the consumer supplies.
//
// The palette filters and orders its own rows rather than leaving it to cmdk, because three sources
// land in one list and one of them is asynchronous. Shortcuts on the rows come from the hotkey
// registry, so a remap shows up here without anyone telling the palette.

export interface PaletteAction {
  id: string
  title: string
  /** Muted text after the title. */
  subtitle?: string
  /** A hotkey scope, `panel:book`. The action is offered only when the palette is opened from inside that scope. Omit for everywhere. */
  scope?: string
  keywords?: readonly string[]
  /** The heading the row sits under. */
  group?: string
  /** A hotkey binding whose keys render on the row. */
  bindingId?: string
  run: () => void
  /** Runs on Shift+Enter. The hint shows on the highlighted row, so it is discoverable. */
  secondary?: { title: string; run: () => void }
}

export interface SymbolResult {
  symbol: string
  name?: string
  exchange?: string
  /** Asset class or instrument type, rendered as a badge. */
  kind?: string
}

export interface SymbolSearchAdapter {
  /** Reject or resolve as you like once `signal` aborts; a stale answer is dropped either way. */
  search(query: string, signal: AbortSignal): Promise<readonly SymbolResult[]>
  /** Default 1. */
  minLength?: number
  /** Default 150. */
  debounceMs?: number
}

export type PaletteRecent = { kind: "action"; id: string } | { kind: "symbol"; symbol: SymbolResult }

export interface ActionRegistry {
  /** Returns the unregister. An action with an id already present replaces it. */
  register(actions: PaletteAction | readonly PaletteAction[]): () => void
  /** Stable array reference until something changes. */
  list(): readonly PaletteAction[]
  /** Most recent first. Stable array reference until something changes. */
  recents(): readonly PaletteRecent[]
  /** Move to the front of the recents. The palette calls this after a row runs. */
  touch(recent: PaletteRecent): void
  /** From the consumer's persistence. Does not notify `onRecentsChange`. */
  loadRecents(recents: readonly PaletteRecent[]): void
  onRecentsChange(cb: (recents: readonly PaletteRecent[]) => void): () => void
  subscribe(cb: () => void): () => void
}

const recentKey = (r: PaletteRecent) => (r.kind === "action" ? `action:${r.id}` : `symbol:${r.symbol.symbol}:${r.symbol.exchange ?? ""}`)

export function createActionRegistry(options: { maxRecents?: number } = {}): ActionRegistry {
  const maxRecents = options.maxRecents ?? 8
  const actions = new Map<string, PaletteAction>()
  const listeners = new Set<() => void>()
  const recentListeners = new Set<(recents: readonly PaletteRecent[]) => void>()
  let snapshot: readonly PaletteAction[] | null = null
  let recents: readonly PaletteRecent[] = []

  function emit() {
    snapshot = null
    for (const cb of listeners) cb()
  }

  return {
    register(input) {
      const added = Array.isArray(input) ? (input as readonly PaletteAction[]) : [input as PaletteAction]
      for (const action of added) actions.set(action.id, action)
      emit()
      return () => {
        // Only what this call registered: a later registration under the same id is someone else's.
        let changed = false
        for (const action of added) if (actions.get(action.id) === action) changed = actions.delete(action.id) || changed
        if (changed) emit()
      }
    },
    list: () => (snapshot ??= [...actions.values()]),
    recents: () => recents,
    touch(recent) {
      const key = recentKey(recent)
      recents = [recent, ...recents.filter((r) => recentKey(r) !== key)].slice(0, maxRecents)
      for (const cb of listeners) cb()
      for (const cb of recentListeners) cb(recents)
    },
    loadRecents(next) {
      recents = next.slice(0, maxRecents)
      for (const cb of listeners) cb()
    },
    onRecentsChange(cb) {
      recentListeners.add(cb)
      return () => recentListeners.delete(cb)
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

/**
 * How well an action answers a query, or -1 when it does not. Every word of the query must land
 * somewhere; a word that starts the title beats one inside it, which beats a keyword, which beats
 * letters in order.
 */
export function scorePaletteAction(action: PaletteAction, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return 0
  const title = action.title.toLowerCase()
  const rest = [action.subtitle, action.group, action.id, ...(action.keywords ?? [])].filter(Boolean).join(" ").toLowerCase()
  let total = 0
  for (const word of words) {
    let score = -1
    if (title === word) score = 100
    else if (title.startsWith(word)) score = 80
    else if (title.includes(` ${word}`)) score = 60
    else if (title.includes(word)) score = 40
    else if (rest.startsWith(word) || rest.includes(` ${word}`)) score = 30
    else if (rest.includes(word)) score = 20
    else if (isSubsequence(word, title)) score = 10
    if (score < 0) return -1
    total += score
  }
  return total
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0
  for (const ch of needle) {
    at = haystack.indexOf(ch, at)
    if (at < 0) return false
    at++
  }
  return true
}

export interface CommandPaletteLabels {
  /** The dialog's accessible name, and the go-bar's. */
  title: string
  description: string
  placeholder: string
  empty: string
  searching: string
  recent: string
  actions: string
  commands: string
  symbols: string
  /** The description of the binding the palette declares for itself. */
  hotkey: string
}

const PALETTE_LABELS: CommandPaletteLabels = {
  title: "Command palette",
  description: "Search for a command or a symbol",
  placeholder: "Type a command or a symbol…",
  empty: "No results",
  searching: "Searching…",
  recent: "Recent",
  actions: "Actions",
  commands: "Commands",
  symbols: "Symbols",
  hotkey: "Open the command palette",
}

const GO_BAR_LABELS: CommandPaletteLabels = { ...PALETTE_LABELS, title: "Command line", placeholder: "Symbol, function, or command", hotkey: "Focus the command line" }

export interface CommandPaletteProps {
  actions: ActionRegistry
  /** `palette` is a dialog. `go-bar` renders inline and drops its rows below the input. */
  variant?: "palette" | "go-bar"
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  symbols?: SymbolSearchAdapter
  onSymbolSelect?: (symbol: SymbolResult) => void
  /** Shift+Enter on a symbol row, after `onSymbolSelect`'s usual work is yours to repeat or skip. */
  symbolSecondary?: { title: string; run: (symbol: SymbolResult) => void }
  /** Rows for what has been typed, `AAPL GP`. The first row is what Enter runs. */
  goBarGrammar?: (input: string) => readonly PaletteAction[]
  /** Defaults to the registry from `HotkeysProvider`, when there is one. `null` opts out. */
  hotkeys?: HotkeyRegistry | null
  /** Keys for the binding the palette declares for itself: `palette.open` (default `mod+k`) or `go-bar.focus` (default `/`). `false` declares nothing. */
  hotkey?: string | false
  labels?: Partial<CommandPaletteLabels>
  /** On the dialog's content for `palette`, on the root for `go-bar`. */
  className?: string
}

interface Row {
  key: string
  title: string
  subtitle?: string
  badge?: string
  keys?: string
  run: () => void
  secondary?: { title: string; run: () => void }
  recent: PaletteRecent | null
}

interface Section {
  heading: string
  rows: Row[]
}

const NO_SYMBOLS: readonly SymbolResult[] = []
const NO_ENTRIES: readonly HotkeyEntry[] = []
const AMBIENT_SCOPES = "editing global"
const SLOT = "tradecn-command-palette"

// Where focus last was outside any palette, as a scope chain. It decides which scoped actions are
// on offer, and it has to be read before the palette takes focus for itself.
let focusScopes = AMBIENT_SCOPES
const focusListeners = new Set<() => void>()

function onFocusIn(event: globalThis.FocusEvent) {
  const target = event.target as Element | null
  if (target && typeof target.closest === "function" && target.closest(`[data-slot="${SLOT}"]`)) return
  const next = scopeChain(target).join(" ")
  if (next === focusScopes) return
  focusScopes = next
  for (const cb of focusListeners) cb()
}

function subscribeFocusScopes(cb: () => void) {
  if (!focusListeners.size) {
    // Nobody was listening, so whatever was remembered is stale. Start from where focus is now.
    const focused = document.activeElement
    focusScopes = focused?.closest(`[data-slot="${SLOT}"]`) ? AMBIENT_SCOPES : scopeChain(focused).join(" ")
    document.addEventListener("focusin", onFocusIn)
  }
  focusListeners.add(cb)
  return () => {
    focusListeners.delete(cb)
    if (!focusListeners.size) document.removeEventListener("focusin", onFocusIn)
  }
}

const getFocusScopes = () => focusScopes
const getServerFocusScopes = () => AMBIENT_SCOPES
const subscribeNothing = () => () => {}
const getNoEntries = () => NO_ENTRIES

function useSymbolSearch(adapter: SymbolSearchAdapter | undefined, query: string) {
  const [found, setFound] = useState<{ query: string; results: readonly SymbolResult[] }>({ query: "", results: NO_SYMBOLS })
  const active = adapter !== undefined && query.length >= (adapter.minLength ?? 1)
  useEffect(() => {
    if (!adapter || !active) return
    const controller = new AbortController()
    const settle = (results: readonly SymbolResult[]) => {
      if (!controller.signal.aborted) setFound({ query, results })
    }
    const timer = setTimeout(() => {
      adapter.search(query, controller.signal).then(settle, () => settle(NO_SYMBOLS))
    }, adapter.debounceMs ?? 150)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [adapter, active, query])
  // Only answers to the query on screen. Enter on a row left over from three letters ago is how the wrong symbol gets loaded.
  const current = active && found.query === query
  return { results: current ? found.results : NO_SYMBOLS, loading: active && !current }
}

function Keys({ keys, platform }: { keys: string; platform?: Platform }) {
  return (
    <span className="inline-flex items-center gap-1">
      {formatKeys(keys, platform).map((caps, i) => (
        <KbdGroup key={i}>
          {caps.map((cap) => (
            <Kbd key={cap}>{cap}</Kbd>
          ))}
        </KbdGroup>
      ))}
    </span>
  )
}

interface BodyProps extends Pick<CommandPaletteProps, "actions" | "symbols" | "onSymbolSelect" | "symbolSecondary" | "goBarGrammar"> {
  variant: "palette" | "go-bar"
  labels: CommandPaletteLabels
  hotkeys: HotkeyRegistry | null
  /** The palette's own binding, to answer it from behind the dialog's wall. */
  ownBindingId: string | null
  scopes: string
  expanded: boolean
  onExpand: () => void
  onDone: () => void
}

function PaletteBody({ actions, symbols, onSymbolSelect, symbolSecondary, goBarGrammar, variant, labels, hotkeys, ownBindingId, scopes, expanded, onExpand, onDone }: BodyProps) {
  const [input, setInput] = useState("")
  const query = input.trim()
  const list = useSyncExternalStore(actions.subscribe, actions.list, actions.list)
  const recents = useSyncExternalStore(actions.subscribe, actions.recents, actions.recents)
  const entries = useSyncExternalStore(hotkeys?.subscribe ?? subscribeNothing, hotkeys?.list ?? getNoEntries, hotkeys?.list ?? getNoEntries)
  const search = useSymbolSearch(symbols, query)

  // Radix focuses the dialog in the commit that mounts it; Base UI does it a few milliseconds later.
  // Keys pressed in that gap land on the body, where a single-key hotkey would take them. Someone who
  // pressed mod+k is already working the palette, so until focus arrives its keys are the palette's:
  // text goes into the query, Enter runs the highlighted row, Escape closes, and nothing reaches the dispatcher.
  const early = useRef<{ enter: (shift: boolean) => void; escape: () => void }>({ enter: () => {}, escape: () => {} })
  useEffect(() => {
    if (variant !== "palette") return
    const inside = (node: EventTarget | null) => Boolean((node as Element | null)?.closest?.(`[data-slot="${SLOT}"]`))
    if (inside(document.activeElement)) return
    const onFocus = (event: globalThis.FocusEvent) => {
      if (inside(event.target)) stop()
    }
    const onKey = (event: KeyboardEvent) => {
      if (inside(event.target)) return stop()
      if (event.isComposing) return
      event.stopPropagation()
      if (event.key === "Enter") early.current.enter(event.shiftKey)
      else if (event.key === "Escape") early.current.escape()
      else if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
      else setInput((typed) => typed + event.key)
      event.preventDefault()
    }
    const timer = setTimeout(() => stop(), 1000)
    function stop() {
      clearTimeout(timer)
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("focusin", onFocus, true)
    }
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("focusin", onFocus, true)
    return stop
  }, [variant])

  const active = new Set(scopes.split(" "))
  const keysOf = new Map(entries.map((e) => [e.id, e.keys]))
  const scopeLabel = (scope: string) => scope.replace(/^panel:/, "")

  const actionRow = (action: PaletteAction, prefix: string, recent: PaletteRecent | null): Row => ({
    key: `${prefix}:${action.id}`,
    title: action.title,
    subtitle: action.subtitle,
    badge: action.scope ? scopeLabel(action.scope) : undefined,
    keys: (action.bindingId && keysOf.get(action.bindingId)) || undefined,
    run: action.run,
    secondary: action.secondary,
    recent,
  })
  const symbolRow = (symbol: SymbolResult, prefix: string): Row => ({
    key: `${prefix}:${symbol.symbol}:${symbol.exchange ?? ""}`,
    title: symbol.symbol,
    subtitle: [symbol.name, symbol.exchange].filter(Boolean).join(" · ") || undefined,
    badge: symbol.kind,
    run: () => onSymbolSelect?.(symbol),
    secondary: symbolSecondary && { title: symbolSecondary.title, run: () => symbolSecondary.run(symbol) },
    recent: { kind: "symbol", symbol },
  })

  const offered = list.filter((a) => !a.scope || active.has(a.scope))
  const sections: Section[] = []
  if (!query) {
    const rows: Row[] = []
    for (const recent of recents) {
      if (recent.kind === "symbol") rows.push(symbolRow(recent.symbol, "recent-symbol"))
      else {
        const action = offered.find((a) => a.id === recent.id)
        if (action) rows.push(actionRow(action, "recent", recent))
      }
    }
    if (rows.length) sections.push({ heading: labels.recent, rows: rows.slice(0, 5) })
    for (const action of offered) pushRow(sections, action.group ?? labels.actions, actionRow(action, "action", { kind: "action", id: action.id }))
  } else {
    const commands = goBarGrammar?.(query) ?? []
    if (commands.length) sections.push({ heading: labels.commands, rows: commands.map((c) => actionRow(c, "command", null)) })
    const scored = offered.map((action) => ({ action, score: scorePaletteAction(action, query) })).filter((s) => s.score >= 0)
    scored.sort((a, b) => b.score - a.score)
    for (const { action } of scored) pushRow(sections, action.group ?? labels.actions, actionRow(action, "action", { kind: "action", id: action.id }))
    if (search.results.length) sections.push({ heading: labels.symbols, rows: search.results.map((s) => symbolRow(s, "symbol")) })
  }
  const rowsByKey = new Map(sections.flatMap((s) => s.rows).map((r) => [r.key, r]))

  const finish = (row: Row, run: () => void) => {
    setInput("")
    onDone()
    if (row.recent) actions.touch(row.recent)
    run()
  }

  useEffect(() => {
    early.current = {
      enter(shift) {
        const selected = document.querySelector(`[data-slot="${SLOT}"][data-variant="palette"] [cmdk-item][aria-selected="true"]`)
        const row = rowsByKey.get(selected?.getAttribute("data-row") ?? "")
        if (row) finish(row, shift && row.secondary ? row.secondary.run : row.run)
      },
      escape: onDone,
    }
  })

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter" && event.shiftKey) {
      const selected = event.currentTarget.querySelector('[cmdk-item][aria-selected="true"]')
      const row = rowsByKey.get(selected?.getAttribute("data-row") ?? "")
      if (!row?.secondary) return
      event.preventDefault()
      finish(row, row.secondary.run)
    } else if (variant === "go-bar" && event.key === "Escape") {
      event.preventDefault()
      setInput("")
      onDone()
    } else if (variant === "palette" && ownBindingId) {
      // The dispatcher stops at the dialog, so the key that opened the palette closes it from here.
      const own = keysOf.get(ownBindingId)
      if (!own || !matchesKeys(event.nativeEvent, own, hotkeys?.platform)) return
      event.preventDefault()
      onDone()
    }
  }

  const hint = (row: Row) =>
    row.secondary && (
      <span
        data-secondary
        className="hidden items-center gap-1 in-data-[selected=true]:inline-flex"
        onClick={(event: MouseEvent) => {
          event.stopPropagation()
          finish(row, row.secondary!.run)
        }}
      >
        <Keys keys="shift+enter" platform={hotkeys?.platform} />
        {row.secondary.title}
      </span>
    )

  const rows = (
    <>
      <CommandEmpty>{search.loading ? labels.searching : labels.empty}</CommandEmpty>
      {sections.map((section) => (
        <CommandGroup key={section.heading} heading={section.heading}>
          {section.rows.map((row) => (
            <CommandItem key={row.key} value={row.key} data-row={row.key} onSelect={() => finish(row, row.run)}>
              <span className="truncate">{row.title}</span>
              {row.subtitle && <span className="truncate text-muted-foreground">{row.subtitle}</span>}
              {row.badge && (
                <Badge variant="outline" className="h-4 px-1 text-xs uppercase">
                  {row.badge}
                </Badge>
              )}
              {(row.secondary || row.keys) && (
                <CommandShortcut className="flex shrink-0 items-center gap-2 tracking-normal">
                  {hint(row)}
                  {row.keys && <Keys keys={row.keys} platform={hotkeys?.platform} />}
                </CommandShortcut>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  )

  if (variant === "palette") {
    return (
      <Command shouldFilter={false} loop label={labels.title} onKeyDown={onKeyDown}>
        <CommandInput value={input} onValueChange={setInput} placeholder={labels.placeholder} />
        <CommandList>{rows}</CommandList>
      </Command>
    )
  }
  return (
    <Command shouldFilter={false} loop label={labels.title} onKeyDown={onKeyDown} className="h-auto overflow-visible bg-transparent p-0">
      <CommandInput value={input} onValueChange={setInput} placeholder={labels.placeholder} onFocus={onExpand} />
      {expanded && (
        // The rows are not focusable; without this a click blurs the input and the list is gone before the click lands.
        <CommandList onMouseDown={(event: MouseEvent) => event.preventDefault()} className="absolute top-full right-0 left-0 z-50 mt-1 rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          {rows}
        </CommandList>
      )}
    </Command>
  )
}

function pushRow(sections: Section[], heading: string, row: Row) {
  const section = sections.find((s) => s.heading === heading)
  if (section) section.rows.push(row)
  else sections.push({ heading, rows: [row] })
}

export function CommandPalette({ actions, variant = "palette", open: openProp, defaultOpen = false, onOpenChange, symbols, onSymbolSelect, symbolSecondary, goBarGrammar, hotkeys: hotkeysProp, hotkey, labels: labelsProp, className }: CommandPaletteProps) {
  const fromContext = useMaybeHotkeys()
  const hotkeys = hotkeysProp === undefined ? fromContext : hotkeysProp
  const labels = { ...(variant === "palette" ? PALETTE_LABELS : GO_BAR_LABELS), ...labelsProp }
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const open = openProp ?? uncontrolled
  const root = useRef<HTMLDivElement>(null)

  // Freeze where focus was at the moment of opening: a render later the palette itself has it.
  const liveScopes = useSyncExternalStore(subscribeFocusScopes, getFocusScopes, getServerFocusScopes)
  const [wasOpen, setWasOpen] = useState(open)
  const [scopes, setScopes] = useState(liveScopes)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setScopes(liveScopes)
  }

  const setOpen = (next: boolean) => {
    if (openProp === undefined) setUncontrolled(next)
    onOpenChange?.(next)
  }

  const bindingId = variant === "palette" ? "palette.open" : "go-bar.focus"
  const keys = hotkey === false ? null : (hotkey ?? (variant === "palette" ? "mod+k" : "/"))
  const description = labels.hotkey
  const group = labels.title
  const onHotkey = useRef(() => {})
  useEffect(() => {
    onHotkey.current = () => {
      if (variant === "palette") setOpen(!open)
      else root.current?.querySelector("input")?.focus()
    }
  })
  useEffect(() => {
    if (!hotkeys || keys === null) return
    // A consumer that declared this id already owns its keys and its wording.
    const declared = hotkeys.list().some((entry) => entry.id === bindingId)
    if (!declared) hotkeys.register({ id: bindingId, keys, scope: variant === "palette" ? "editing" : "global", description, group })
    const unbind = hotkeys.bind(bindingId, () => onHotkey.current())
    return () => {
      unbind()
      if (!declared) hotkeys.unregister(bindingId)
    }
  }, [hotkeys, keys, bindingId, variant, description, group])

  const body = (expanded: boolean) => (
    <PaletteBody
      actions={actions}
      symbols={symbols}
      onSymbolSelect={onSymbolSelect}
      symbolSecondary={symbolSecondary}
      goBarGrammar={goBarGrammar}
      variant={variant}
      labels={labels}
      hotkeys={hotkeys}
      ownBindingId={keys === null ? null : bindingId}
      scopes={scopes}
      expanded={expanded}
      onExpand={() => setOpen(true)}
      onDone={() => {
        setOpen(false)
        if (variant === "go-bar") root.current?.querySelector("input")?.blur()
      }}
    />
  )

  if (variant === "palette") {
    return (
      <CommandDialog open={open} onOpenChange={setOpen} title={labels.title} description={labels.description} className={className}>
        {/* min-w-0: DialogContent is a CSS grid container, and a grid item's default min-width is
            "auto" (its content's min-content size), not 0. A long, unwrapped row label (e.g. "Add
            curve — WTI 1-Month Spreads") then forces this item wider than the dialog's own max-w-sm,
            which the dialog clips -- asymmetrically, cutting the first couple of characters off the
            left edge rather than the end. min-w-0 lets it shrink to the column and truncate as designed. */}
        <div data-slot="tradecn-command-palette" data-variant="palette" className="min-w-0 lining-nums tabular-nums">
          {body(true)}
        </div>
      </CommandDialog>
    )
  }
  return (
    <div
      ref={root}
      data-slot="tradecn-command-palette"
      data-variant="go-bar"
      className={cn("relative w-full lining-nums tabular-nums", className)}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      {body(open)}
    </div>
  )
}
