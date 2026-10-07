import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { createBroadcastChannelTransport, createLinkGroupStore, cycleLinkGroup, normalizeSymbol, type LinkGroup, type LinkGroupStore, type LinkTransport } from "@/lib/link-group"

// React bindings for the link-group store: a provider that owns one and keeps it connected, and a
// hook that gives a panel its group and its symbol.

const StoreContext = createContext<LinkGroupStore | null>(null)

export interface LinkGroupProviderProps {
  /** Bring your own, to seed it or to share one between roots. One is created otherwise, and `transport` and `channel` are ignored. */
  store?: LinkGroupStore
  /** How a link reaches other windows. BroadcastChannel by default; `null` keeps links inside this window. Read once. */
  transport?: LinkTransport | null
  /** The BroadcastChannel name for the default transport. Read once. */
  channel?: string
  children?: ReactNode
}

export function LinkGroupProvider({ store, transport, channel, children }: LinkGroupProviderProps) {
  const [own] = useState(() => createLinkGroupStore({ transport: transport === undefined ? createBroadcastChannelTransport(channel) : transport }))
  const value = store ?? own
  useEffect(() => value.connect(), [value])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

/** The store from the nearest provider. */
export function useLinkGroupStore(): LinkGroupStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error("useLinkGroup needs a <LinkGroupProvider> above it")
  return store
}

export interface UseLinkGroupOptions {
  /** Controlled group, for a layout that persists it. */
  group?: LinkGroup
  defaultGroup?: LinkGroup
  onGroupChange?: (group: LinkGroup) => void
  /** What the panel shows before anyone sets anything. */
  defaultSymbol?: string | null
  /** The symbol this panel shows changed, by its own hand or through its group. The moment to persist. */
  onSymbolChange?: (symbol: string | null) => void
  /** Recorded on the group with every write from here: usually the panel's id. */
  source?: string
}

export interface LinkGroupHandle {
  group: LinkGroup
  symbol: string | null
  /** Sets this panel's symbol and, when it is linked, its group's. */
  setSymbol: (symbol: string | null) => void
  setGroup: (group: LinkGroup) => void
  /** Unlinked, 1, 2, 3, 4, unlinked. */
  cycleGroup: (step?: 1 | -1) => void
}

/**
 * A panel's group and symbol. Unlinked, the symbol is the panel's own. Linked, it is the group's:
 * joining a group that has a symbol adopts it, joining an empty one gives it this panel's, and
 * leaving keeps whatever was showing.
 */
export function useLinkGroup(options: UseLinkGroupOptions = {}): LinkGroupHandle {
  const { group: controlled, defaultGroup = null, onGroupChange, defaultSymbol = null, onSymbolChange, source = null } = options
  const store = useLinkGroupStore()
  const [ownGroup, setOwnGroup] = useState<LinkGroup>(defaultGroup)
  const group = controlled !== undefined ? controlled : ownGroup
  const [symbol, setOwnSymbol] = useState<string | null>(() => normalizeSymbol(defaultSymbol))
  const linked = useSyncExternalStore(
    store.subscribe,
    () => (group === null ? null : store.get(group)),
    () => null,
  )
  // Follow the group once it has something to say, a clear included. State set during render, so the
  // panel never paints the symbol it just left behind.
  if (linked && (linked.version > 0 || linked.symbol !== null) && linked.symbol !== symbol) setOwnSymbol(linked.symbol)

  // A group nobody has written to takes the symbol of the first panel to join it.
  useEffect(() => {
    if (group !== null) store.seed(group, symbol, source)
  }, [store, group, symbol, source])

  const notify = useRef(onSymbolChange)
  useEffect(() => {
    notify.current = onSymbolChange
  })
  const told = useRef(symbol)
  useEffect(() => {
    if (told.current === symbol) return
    told.current = symbol
    notify.current?.(symbol)
  }, [symbol])

  const setSymbol = useCallback(
    (next: string | null) => {
      const value = normalizeSymbol(next)
      setOwnSymbol(value)
      if (group !== null) store.set(group, value, source)
    },
    [store, group, source],
  )
  const setGroup = useCallback(
    (next: LinkGroup) => {
      if (controlled === undefined) setOwnGroup(next)
      onGroupChange?.(next)
    },
    [controlled, onGroupChange],
  )
  const cycleGroup = useCallback((step: 1 | -1 = 1) => setGroup(cycleLinkGroup(group, step)), [group, setGroup])

  return { group, symbol, setSymbol, setGroup, cycleGroup }
}
